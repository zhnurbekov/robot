import {Inject, Injectable, Logger, forwardRef} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {PortalProcessorService} from "../portal-processor/portal-processor.service";
import {PortalService} from '../portal/portal.service';
import {AuthService} from '../auth/auth.service';
import {NcanodeService} from '../ncanode/ncanode.service';
import {HttpService} from '../http/http.service';
import {RedisService} from '../redis/redis.service';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

@Injectable()
export class ApplicationService {
	private readonly logger = new Logger(ApplicationService.name);
	
	private readonly tempDir: string;
	private readonly fileCacheKeyPrefix = 'file:cache:';
	private readonly signedFileCacheKeyPrefix = 'file:signed:';
	private readonly maxCacheSize = 10 * 1024 * 1024; // 10 МБ - максимальный размер файла для кэширования в Redis
	private readonly fileCacheTtl = 60 * 60; // 1 час для кэша файлов
	private readonly enableFileCache: boolean;
	
	constructor(
		private configService: ConfigService,
		private portalService: PortalService,
		private authService: AuthService,
		private ncanodeService: NcanodeService,
		@Inject(forwardRef(() => PortalProcessorService))
		private portalProcessorService: PortalProcessorService,
		private httpService: HttpService,
		private redisService: RedisService,
	) {
		this.enableFileCache = this.configService.get<boolean>('ENABLE_REDIS_FILE_CACHE', false);
		// Создаем временную директорию для файлов (fallback для больших файлов)
		this.tempDir = path.join(os.tmpdir(), 'goszakup-docs');
		this.ensureTempDir();
		
		// Устанавливаем callback для автоматической переавторизации при обнаружении "авторизуйтесь заново"
		this.httpService.setOnReauthRequiredCallback(async () => {
			this.logger.warn('🔄 Требуется переавторизация (обнаружен текст "авторизуйтесь заново" в ответе)');
			try {
				const success = await this.authService.login(true); // force=true для принудительной авторизации
				if (success) {
					this.logger.log('✅ Переавторизация выполнена успешно');
				} else {
					this.logger.error('❌ Переавторизация не удалась');
				}
				return success;
			} catch (error) {
				this.logger.error(`❌ Ошибка при переавторизации: ${(error as Error).message}`);
				return false;
			}
		});
		this.logger.log('Callback для автоматической переавторизации установлен');
	}
	
	private async ensureTempDir(): Promise<void> {
		try {
			await fs.mkdir(this.tempDir, {recursive: true});
		} catch (error) {
			this.logger.error(`Ошибка создания временной директории: ${(error as Error).message}`);
		}
	}
	
	async submitApplication(applicationNumber: any) {
		const startTime = Date.now();
		let applicationId: string | null = null;
		const timings: Record<string, number> = {};
		
		try {
			const announcementsId = applicationNumber;
			if (!announcementsId) {
				throw new Error('Не указан ID объявления');
			}
			
			// Проверяем авторизацию только если нужно
			let t = Date.now();
			await this.authService.login();
			timings['login'] = Date.now() - t;
			
			// Создаем объявление
			t = Date.now();
			const announcement = await this.portalProcessorService.processAnnouncementCreate(announcementsId);
			timings['processAnnouncementCreate'] = Date.now() - t;
			
			if (!announcement?.applicationId) {
				throw new Error('Не удалось создать заявку или получить applicationId');
			}
			
			applicationId = announcement.applicationId;

			// ОПТИМИЗАЦИЯ: получаем taskId и обработчики без taskId параллельно, затем обработчики с taskId
			t = Date.now();
			const [taskId, , , ,] = await Promise.all([
				this.portalProcessorService.getIdDataSheetHandle(announcementsId, applicationId, '3357'),
			
			
			]);
			timings['batch1_getId_appendix_copying_permits'] = Date.now() - t;
			
			if (taskId == null) {
				throw new Error('Не удалось получить taskId (getIdDataSheetHandle)');
			}

			t = Date.now();
			await Promise.all([
				this.portalProcessorService.setupBeneficialOwnershipInformation(announcementsId, applicationId, '3361', taskId),
				this.portalProcessorService.copyingQualificationInformation(announcementsId, applicationId, '3362'),
				this.portalProcessorService.appendixHandle(announcementsId, applicationId, '1356'),
				this.portalProcessorService.appendixHandle(announcementsId, applicationId, '3352'),
				this.portalProcessorService.obtainPermits(announcementsId, applicationId, '1351'),
				this.portalProcessorService.addingBidSecurity(announcementsId, applicationId, '3353', taskId),
				this.portalProcessorService.dataSheetHandle(announcementsId, applicationId, '3357', taskId, '1'),
				this.portalProcessorService.dataSheetHandle(announcementsId, applicationId, '3357', taskId, '2'),
			]);
			timings['batch2_beneficial_bidSecurity_dataSheet_1_2'] = Date.now() - t;

			// Устанавливаем цену
			t = Date.now();
			try {
				await this.portalProcessorService.setPrice(announcementsId, applicationId, '3353');
			} catch (error) {
				this.logger.error(`[${applicationId}] Ошибка setPrice: ${(error as Error).message}`);
				this.logger.warn(`[${applicationId}] Процесс продолжает работу (ошибка залогирована).`);
				// Не выбрасываем — процесс не завершается
			}
			timings['setPrice'] = Date.now() - t;
			
			const duration = Date.now() - startTime;
			const timingStr = Object.entries(timings)
				.map(([k, v]) => `${k}=${v}ms`)
				.join(', ');
			this.logger.log(`[${applicationId}] ✅ Все операции завершены за ${duration}ms | ${timingStr}`);
			
		} catch (error) {
			const duration = Date.now() - startTime;
			this.logger.error(`Ошибка подачи заявки за ${duration}ms: ${(error as Error).message}`);
			
			// Если заявка была создана, удаляем её
			if (applicationId) {
				try {
					this.logger.log(`Попытка удаления заявки ${applicationId} из-за ошибки...`);
					await this.portalService.deleteApplication(applicationId);
					this.logger.log(`✅ Заявка ${applicationId} успешно удалена`);
				} catch (deleteError) {
					this.logger.error(`❌ Не удалось удалить заявку ${applicationId}: ${(deleteError as Error).message}`);
				}
			}
			
			throw error;
		}
	}
	
	
	/**
	 * Обработка одного документа: получение ссылки → скачивание → подпись → возврат подписанного документа
	 * @param announceId - ID объявления
	 * @param applicationId - ID заявки
	 * @param docId - ID документа
	 */
	async processDocument(
		announceId: string,
		applicationId: string,
		docId: string,
	): Promise<{
		success: boolean;
		docId: string;
		signedDocument?: Buffer | string;
		fileName?: string;
		fileIdentifier?: string | null;
		error?: string;
		duration?: number;
		alreadySigned?: boolean;
	}> {
		const startTime = Date.now();
		const taskId = `doc-${docId}`;
		
		this.logger.log(`[${taskId}] Начало обработки документа`);
		
		try {
			// Шаг 1: Получить ссылку на файл и fileIdentifier (сформировать документ)
			this.logger.log(`[${taskId}] Шаг 1: Получение ссылки на файл...`);
			const fileUrlResult = await this.getDocumentFileUrl(announceId, applicationId, docId);
			const {fileUrl, fileIdentifier, alreadySigned} = fileUrlResult;
			
			// Если файл уже подписан, пропускаем обработку
			if (alreadySigned) {
				this.logger.log(`[${taskId}] Файл уже подписан, пропускаем обработку`);
				return {
					success: true,
					docId,
					alreadySigned: true,
				};
			}
			
			if (!fileUrl) {
				throw new Error('Не удалось получить ссылку на файл');
			}
			
			this.logger.log(`[${taskId}] Ссылка на файл получена: ${fileUrl}`);
			if (fileIdentifier) {
				this.logger.log(`[${taskId}] fileIdentifier получен: ${fileIdentifier}`);
			}
			
			// Шаг 2: Скачать файл в память (с кэшированием в Redis)
			this.logger.log(`[${taskId}] Шаг 2: Скачивание файла...`);
			const {fileBuffer, fileName, ext} = await this.downloadFileToMemory(fileUrl, taskId);
			this.logger.log(`[${taskId}] Файл скачан в память: ${fileName} (${fileBuffer.length} байт)`);
			
			// Шаг 3: Подписать файл в памяти через ncanode (с кэшированием в Redis)
			this.logger.log(`[${taskId}] Шаг 3: Подписание файла через ncanode...`);
			const signedDocument = await this.signFileInMemory(fileBuffer, ext, taskId, fileUrl);
			this.logger.log(`[${taskId}] Файл подписан в памяти`);
			
			const duration = Date.now() - startTime;
			this.logger.log(`[${taskId}] Обработка завершена за ${duration}ms`);
			
			// Определяем формат возврата (Buffer или base64 строка)
			let signedDocumentResult: Buffer | string = signedDocument;
			
			// Для XML возвращаем как строку, для остальных - как Buffer
			if (ext === '.xml' && typeof signedDocument !== 'string') {
				signedDocumentResult = signedDocument.toString('utf-8');
			}
			
			return {
				success: true,
				docId,
				signedDocument: signedDocumentResult,
				fileName,
				fileIdentifier,
				duration,
			};
		} catch (error) {
			const duration = Date.now() - startTime;
			const errorMessage = (error as Error).message;
			this.logger.error(`[${taskId}] Ошибка обработки документа: ${errorMessage}`);
			
			return {
				success: false,
				docId,
				error: errorMessage,
				duration,
			};
		}
	}
	
	/**
	 * Получить ссылку на файл документа и fileIdentifier
	 */
	private async getDocumentFileUrl(
		announceId: string,
		applicationId: string,
		docId: string,
	): Promise<{ fileUrl: string | null; fileIdentifier: string | null; alreadySigned?: boolean }> {
		try {
			// Используем существующий метод для формирования документа
			const response = await this.portalService.request({
				url: `/ru/application/show_doc/${announceId}/${applicationId}/${docId}`,
				method: 'POST',
				isFormData: false,
				data: {
					generate: 'Сформировать документ',
				},
				additionalHeaders: {
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
					'Content-Type': 'application/x-www-form-urlencoded',
					'Referer': `https://v3bl.goszakup.gov.kz/ru/application/show_doc/${announceId}/${applicationId}/${docId}`,
				}
			});
			
			let fileIdentifier: string | null = null;
			let fileUrl: string | null = null;
			
			if (response.data && typeof response.data === 'string') {
				const html = response.data as string;
				
				// 1. Сначала пробуем вытащить прямую ссылку для скачивания из data-url
				//    Пример: data-url="/ru/application/files/download_file/288459834/"
				const dataUrlMatch = html.match(/data-url=["']([^"']+)["']/i);
				if (dataUrlMatch && dataUrlMatch[1]) {
					fileUrl = dataUrlMatch[1];
				}
				
				// 2. Параллельно достаём fileIdentifier, если он есть
				const idMatch = html.match(/data-file-identifier=["']([^"']+)["']/i);
				if (idMatch && idMatch[1]) {
					fileIdentifier = idMatch[1];
				}
				
				// 3. Если data-url нет, пробуем старую логику (href / download-ссылки)
				if (!fileUrl) {
					const extracted = this.extractFileUrlFromHtml(html);
					if (extracted) {
						fileUrl = extracted;
					}
				}
			}
			
			// Если нашли ссылку (через data-url или href) — возвращаем её
			if (fileUrl) {
				return {
					fileUrl,
					fileIdentifier,
				};
			}
			
			// Фоллбек: ничего не нашли — пусть наверху решают, что делать
			return {
				fileUrl: null,
				fileIdentifier,
			};
		} catch (error) {
			this.logger.error(`Ошибка получения ссылки на файл: ${(error as Error).message}`);
			throw error;
		}
	}
	
	/**
	 * Извлечь URL файла из HTML
	 */
	private extractFileUrlFromHtml(html: string): string | null {
		const patterns = [
			/href\s*=\s*["']([^"']+download[^"']*)["']/i,
			/data-file-identifier\s*=\s*["']([^"']+)["']/i,
			/download[^"']*href\s*=\s*["']([^"']+)["']/i,
		];
		
		for (const pattern of patterns) {
			const match = html.match(pattern);
			if (match && match[1]) {
				return match[1];
			}
		}
		
		return null;
	}
	
	/**
	 * Скачать файл в память (Buffer) с кэшированием в Redis
	 * Использует Redis для кэширования, если файл уже был скачан
	 */
	private async downloadFileToMemory(
		fileUrl: string,
		taskId: string,
	): Promise<{ fileBuffer: Buffer; fileName: string; ext: string }> {
		try {
			// Создаем хэш URL для кэширования
			const urlHash = crypto.createHash('sha256').update(fileUrl).digest('hex');
			const cacheKey = `${this.fileCacheKeyPrefix}${urlHash}`;
			
			// Пробуем получить из кэша Redis (если кэширование включено)
			if (this.enableFileCache) {
				const cachedFile = await this.redisService.get(cacheKey);
				if (cachedFile) {
					this.logger.debug(`[${taskId}] Файл получен из кэша Redis: ${fileUrl}`);
					const cachedData = JSON.parse(cachedFile);
					return {
						fileBuffer: Buffer.from(cachedData.data, 'base64'),
						fileName: cachedData.fileName,
						ext: cachedData.ext,
					};
				}
			}
			
			// Если нет в кэше, скачиваем
			const baseURL = this.configService.get<string>('PORTAL_BASE_URL', 'https://v3bl.goszakup.gov.kz');
			const fullUrl = fileUrl.startsWith('http') ? fileUrl : `${baseURL}${fileUrl}`;
			
			this.logger.debug(`[${taskId}] Скачивание файла с ${fullUrl}`);
			
			// Скачиваем через httpService для сохранения cookies
			const response = await this.httpService.get(fileUrl, {
				responseType: 'arraybuffer',
				timeout: 60000,
			});
			
			const fileBuffer = Buffer.from(response.data);
			
			// Определяем расширение файла
			// Сначала проверяем расширение из URL
			let ext = '.tmp';
			const urlLower = fileUrl.toLowerCase();
			if (urlLower.includes('.pdf')) ext = '.pdf';
			else if (urlLower.includes('.docx')) ext = '.docx';
			else if (urlLower.includes('.doc')) ext = '.doc';
			else if (urlLower.includes('.xml')) ext = '.xml';
			else if (urlLower.includes('.zip')) ext = '.zip';
			else {
				// Если не нашли в URL, проверяем content-type
				const contentType = response.headers['content-type'] || '';
				if (contentType.includes('pdf')) ext = '.pdf';
				else if (contentType.includes('docx') || contentType.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document')) ext = '.docx';
				else if (contentType.includes('doc') || contentType.includes('application/msword')) ext = '.doc';
				else if (contentType.includes('xml') && (contentType.includes('text/xml') || contentType.includes('application/xml'))) ext = '.xml';
				else if (contentType.includes('zip')) ext = '.zip';
				else {
					// Проверяем magic bytes для более точного определения
					// PDF: %PDF
					if (fileBuffer.length >= 4 && fileBuffer[0] === 0x25 && fileBuffer[1] === 0x50 && fileBuffer[2] === 0x44 && fileBuffer[3] === 0x46) {
						ext = '.pdf';
					}
					// ZIP/DOCX: PK (ZIP signature)
					else if (fileBuffer.length >= 2 && fileBuffer[0] === 0x50 && fileBuffer[1] === 0x4B) {
						// Проверяем, это docx или обычный zip
						const bufferStr = fileBuffer.toString('utf-8', 0, Math.min(1000, fileBuffer.length));
						if (bufferStr.includes('word/') || bufferStr.includes('[Content_Types].xml')) {
							ext = '.docx';
						} else {
							ext = '.zip';
						}
					}
					// XML: начинается с <?xml или <root
					else if (fileBuffer.length >= 5) {
						const startStr = fileBuffer.toString('utf-8', 0, Math.min(100, fileBuffer.length)).trim();
						if (startStr.startsWith('<?xml') || startStr.startsWith('<root') || startStr.startsWith('<')) {
							// Проверяем, что это действительно XML (нет недопустимых символов)
							try {
								const testStr = fileBuffer.toString('utf-8');
								// Проверяем на наличие недопустимых XML символов (0x00-0x08, 0x0B-0x0C, 0x0E-0x1F кроме 0x09, 0x0A, 0x0D)
								const invalidXmlChars = /[\x00-\x08\x0B-\x0C\x0E-\x1F]/;
								if (!invalidXmlChars.test(testStr)) {
									ext = '.xml';
								}
							} catch (e) {
								// Если не удалось преобразовать в строку, это не XML
							}
						}
					}
				}
			}
			
			const fileName = `${taskId}-${Date.now()}${ext}`;
			
			// Кэшируем в Redis только если файл небольшой
			if (fileBuffer.length <= this.maxCacheSize) {
				const cacheData = {
					data: fileBuffer.toString('base64'),
					fileName,
					ext,
				};
				await this.redisService.set(cacheKey, JSON.stringify(cacheData), this.fileCacheTtl);
				this.logger.debug(`[${taskId}] Файл сохранен в кэш Redis: ${fileUrl} (${fileBuffer.length} байт)`);
			} else {
				this.logger.debug(`[${taskId}] Файл слишком большой для кэширования: ${fileBuffer.length} байт`);
			}
			
			return {fileBuffer, fileName, ext};
		} catch (error) {
			this.logger.error(`[${taskId}] Ошибка скачивания файла: ${(error as Error).message}`);
			throw error;
		}
	}
	
	/**
	 * Подписать файл в памяти (Buffer) с кэшированием в Redis
	 * Использует Redis для кэширования подписанных файлов
	 * @param fileUrl - опциональный URL файла для удаления оригинального файла из кэша после подписания
	 */
	private async signFileInMemory(
		fileBuffer: Buffer,
		ext: string,
		taskId: string,
		fileUrl?: string,
	): Promise<Buffer | string> {
		try {
			// Создаем хэш файла для кэширования подписанной версии
			const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
			const cacheKey = `${this.signedFileCacheKeyPrefix}${fileHash}`;
			
			// Пробуем получить подписанный файл из кэша Redis (если кэширование включено)
			if (this.enableFileCache) {
				const cachedSigned = await this.redisService.get(cacheKey);
				if (cachedSigned) {
					this.logger.debug(`[${taskId}] Подписанный файл получен из кэша Redis`);
					const cachedData = JSON.parse(cachedSigned);
					if (cachedData.isString) {
						return cachedData.data;
					}
					return Buffer.from(cachedData.data, 'base64');
				}
			}
			
			// Если нет в кэше, подписываем
			const certPath = this.configService.get<string>('CERT_PATH', '');
			const certPassword = this.configService.get<string>('CERT_PASSWORD', '');
			
			if (!certPath || !certPassword) {
				throw new Error('Не указан путь к сертификату или пароль');
			}
			
			let signedData: any;
			
			// Проверяем, что файл действительно XML перед подписанием как XML
			// docx файлы могут иметь content-type xml, но это бинарные файлы
			if (ext === '.xml') {
				// Дополнительная проверка: пытаемся преобразовать в строку и проверить на валидность XML
				try {
					const xmlContent = fileBuffer.toString('utf-8');
					// Проверяем на наличие недопустимых XML символов
					const invalidXmlChars = /[\x00-\x08\x0B-\x0C\x0E-\x1F]/;
					if (invalidXmlChars.test(xmlContent)) {
						// Файл содержит недопустимые символы для XML, подписываем как бинарный
						this.logger.warn(`[${taskId}] Файл имеет расширение .xml, но содержит недопустимые XML символы. Подписываем как бинарный файл.`);
						signedData = await this.ncanodeService.sign(fileBuffer, certPath, certPassword, true);
					} else {
						// Это валидный XML файл
						signedData = await this.ncanodeService.signWithNclayer(xmlContent, certPath, certPassword);
					}
				} catch (error) {
					// Если не удалось преобразовать в строку, подписываем как бинарный
					this.logger.warn(`[${taskId}] Не удалось обработать файл как XML: ${(error as Error).message}. Подписываем как бинарный файл.`);
					signedData = await this.ncanodeService.sign(fileBuffer, certPath, certPassword, true);
				}
			} else {
				// Все остальные файлы (pdf, doc, docx, zip и т.д.) подписываем как бинарные
				signedData = await this.ncanodeService.sign(fileBuffer, certPath, certPassword, true);
			}
			
			// Обрабатываем результат подписания
			let signedDocument: Buffer | string;
			let isString = false;
			
			if (typeof signedData === 'string') {
				signedDocument = signedData;
				isString = true;
			} else if (signedData.xml) {
				signedDocument = signedData.xml;
				isString = true;
			} else if (signedData.signature) {
				signedDocument = Buffer.from(signedData.signature, 'base64');
				isString = false;
			} else {
				signedDocument = Buffer.from(JSON.stringify(signedData), 'utf-8');
				isString = false;
			}
			
			// Кэшируем подписанный файл в Redis только если кэширование включено и файл небольшой
			if (this.enableFileCache) {
				const signedSize = typeof signedDocument === 'string'
					? Buffer.byteLength(signedDocument, 'utf-8')
					: signedDocument.length;
				
				if (signedSize <= this.maxCacheSize) {
					const cacheData = {
						data: typeof signedDocument === 'string'
							? signedDocument
							: signedDocument.toString('base64'),
						isString,
					};
					await this.redisService.set(cacheKey, JSON.stringify(cacheData), this.fileCacheTtl);
					this.logger.debug(`[${taskId}] Подписанный файл сохранен в кэш Redis (${signedSize} байт)`);
				} else {
					this.logger.debug(`[${taskId}] Подписанный файл слишком большой для кэширования: ${signedSize} байт`);
				}
			}
			
			// Удаляем оригинальный файл из кэша Redis после успешного подписания
			if (this.enableFileCache && fileUrl) {
				try {
					const urlHash = crypto.createHash('sha256').update(fileUrl).digest('hex');
					const originalFileCacheKey = `${this.fileCacheKeyPrefix}${urlHash}`;
					await this.redisService.delete(originalFileCacheKey);
					this.logger.debug(`[${taskId}] Оригинальный файл удален из кэша Redis: ${fileUrl}`);
				} catch (error) {
					this.logger.warn(`[${taskId}] Не удалось удалить оригинальный файл из кэша: ${(error as Error).message}`);
				}
			}
			
			return signedDocument;
		} catch (error) {
			this.logger.error(`[${taskId}] Ошибка подписания файла: ${(error as Error).message}`);
			throw error;
		}
	}
	
	
	/**
	 * Параллельная обработка документов: запускает 9 методов через Promise.all
	 * @param announceId - ID объявления
	 * @param applicationId - ID заявки
	 * @param docIds - Массив ID документов (до 9)
	 */
	async processDocumentsParallel(
		announceId: string,
		applicationId: string,
		docIds: string[],
	) {
		try {
			if (docIds.length === 0) {
				throw new Error('Не указаны ID документов');
			}
			
			if (docIds.length > 9) {
				throw new Error('Максимальное количество документов: 9');
			}
			
			this.logger.log(
				`Начало параллельной обработки ${docIds.length} документов для заявки ${applicationId}`,
			);
			
			const startTime = Date.now();
			
			// Запускаем все методы параллельно через Promise.all
			const results = await Promise.all(
				docIds.map((docId) =>
					this.processDocument(announceId, applicationId, docId),
				),
			);
			
			const duration = Date.now() - startTime;
			
			// Анализируем результаты
			const successCount = results.filter((r) => r.success).length;
			const failedCount = results.filter((r) => !r.success).length;
			
			this.logger.log(
				`Параллельная обработка завершена за ${duration}ms: ${successCount} успешно, ${failedCount} с ошибками`,
			);
			
			return {
				success: failedCount === 0,
				total: docIds.length,
				successful: successCount,
				failed: failedCount,
				duration,
				results,
			};
		} catch (error) {
			this.logger.error(
				`Ошибка параллельной обработки документов: ${error.message}`,
			);
			throw error;
		}
	}
	
	/**
	 * Скачать файл по URL (старый метод для обратной совместимости)
	 * @deprecated Используйте downloadFileToMemory для работы в памяти
	 */
	private async downloadFile(fileUrl: string, taskId: string): Promise<string> {
		try {
			// Получаем полный URL
			const baseURL = this.configService.get<string>('PORTAL_BASE_URL', 'https://v3bl.goszakup.gov.kz');
			const fullUrl = fileUrl.startsWith('http') ? fileUrl : `${baseURL}${fileUrl}`;
			
			this.logger.debug(`[${taskId}] Скачивание файла с ${fullUrl}`);
			
			// Скачиваем через httpService для сохранения cookies
			const response = await this.httpService.get(fileUrl, {
				responseType: 'arraybuffer',
				timeout: 60000,
			});
			
			// Определяем расширение файла
			const contentType = response.headers['content-type'] || '';
			let ext = '.tmp';
			if (contentType.includes('pdf')) ext = '.pdf';
			else if (contentType.includes('xml')) ext = '.xml';
			else if (contentType.includes('doc')) ext = '.doc';
			else if (contentType.includes('zip')) ext = '.zip';
			
			const fileName = `${taskId}-${Date.now()}${ext}`;
			const filePath = path.join(this.tempDir, fileName);
			
			// Сохраняем файл
			await fs.writeFile(filePath, Buffer.from(response.data));
			
			this.logger.debug(`[${taskId}] Файл сохранен: ${filePath}`);
			return filePath;
		} catch (error) {
			this.logger.error(`[${taskId}] Ошибка скачивания файла: ${(error as Error).message}`);
			throw error;
		}
	}
	
	/**
	 * Подписать файл через ncanode
	 */
	private async signFile(filePath: string, taskId: string): Promise<string> {
		try {
			// Читаем файл
			const fileBuffer = await fs.readFile(filePath);
			
			// Получаем путь к сертификату и пароль
			const certPath = this.configService.get<string>('CERT_PATH', '');
			const certPassword = this.configService.get<string>('CERT_PASSWORD', '');
			
			if (!certPath || !certPassword) {
				throw new Error('Не указан путь к сертификату или пароль');
			}
			
			// Определяем тип файла по расширению
			const ext = path.extname(filePath).toLowerCase();
			let signedData: any;
			
			if (ext === '.xml') {
				// Для XML используем signXml
				const xmlContent = fileBuffer.toString('utf-8');
				signedData = await this.ncanodeService.signWithNclayer(xmlContent, certPath, certPassword);
			} else {
				// Для других файлов используем обычную подпись
				signedData = await this.ncanodeService.sign(fileBuffer, certPath, certPassword, true);
				console.log(signedData)
			}
			
			// Сохраняем подписанный файл
			const signedFileName = `${taskId}-signed-${Date.now()}${ext}`;
			const signedFilePath = path.join(this.tempDir, signedFileName);
			
			if (typeof signedData === 'string') {
				await fs.writeFile(signedFilePath, signedData, 'utf-8');
			} else if (signedData.xml) {
				await fs.writeFile(signedFilePath, signedData.xml, 'utf-8');
			} else if (signedData.signature) {
				await fs.writeFile(signedFilePath, signedData.signature, 'base64');
			} else {
				await fs.writeFile(signedFilePath, JSON.stringify(signedData), 'utf-8');
			}
			
			this.logger.debug(`[${taskId}] Подписанный файл сохранен: ${signedFilePath}`);
			return signedFilePath;
		} catch (error) {
			this.logger.error(`[${taskId}] Ошибка подписания файла: ${(error as Error).message}`);
			throw error;
		}
	}
	
	/**
	 * Отправить подписанный файл на сервер
	 */
	private async uploadSignedFile(
		filePath: string,
		announceId: string,
		applicationId: string,
		docId: string,
	): Promise<any> {
		try {
			// Читаем файл
			const fileBuffer = await fs.readFile(filePath);
			const fileName = path.basename(filePath);
			
			// Формируем URL для загрузки
			const uploadUrl = `/ru/application/upload_signed_doc/${announceId}/${applicationId}/${docId}`;
			
			// Отправляем через FormData
			const formData: Record<string, any> = {
				file: fileBuffer,
				announceId,
				applicationId,
				docId,
			};
			
			const response = await this.httpService.postFormData(uploadUrl, formData);
			
			return response.data;
		} catch (error) {
			this.logger.error(`Ошибка отправки файла: ${(error as Error).message}`);
			throw error;
		}
	}
	
	/**
	 * Очистка временных файлов
	 */
	private async cleanupFiles(filePaths: string[]): Promise<void> {
		for (const filePath of filePaths) {
			try {
				await fs.unlink(filePath);
				this.logger.debug(`Временный файл удален: ${filePath}`);
			} catch (error) {
				this.logger.warn(`Не удалось удалить временный файл ${filePath}: ${(error as Error).message}`);
			}
		}
	}
}


