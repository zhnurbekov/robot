import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApplicationService } from '../application/application.service';
import { PortalService } from '../portal/portal.service';
import { HttpService } from '../http/http.service';
import { NcanodeService } from '../ncanode/ncanode.service';
import { RedisService } from '../redis/redis.service';
import { Buffer } from 'buffer';
import * as crypto from 'crypto';

@Injectable()
export class AppendixService {
	private readonly logger = new Logger(AppendixService.name);
	private readonly fileCacheKeyPrefix = 'file:cache:';
	private readonly signedFileCacheKeyPrefix = 'file:signed:';
	private readonly maxCacheSize = 10 * 1024 * 1024; // 10 МБ - максимальный размер файла для кэширования в Redis
	private readonly fileCacheTtl = 60 * 60; // 1 час для кэша файлов
	private readonly enableFileCache: boolean;

	constructor(
		private applicationService: ApplicationService,
		private portalService: PortalService,
		private configService: ConfigService,
		private httpService: HttpService,
		private ncanodeService: NcanodeService,
		private redisService: RedisService,
	) {
		this.enableFileCache = this.configService.get<boolean>('ENABLE_REDIS_FILE_CACHE', true);
	}

	async firstAppendixHandle(announceId: string, applicationId: string, docId: string): Promise<any> {
		this.logger.log(`Обработка формирования документа ${docId} для заявки ${applicationId}...`);

		try {
			// Получить подписанный документ и fileIdentifier используя processDocument
			// processDocument уже делает запрос на формирование документа и извлекает fileIdentifier
			this.logger.log(`[${docId}] Получение подписанного документа...`);
			const docResult = await this.applicationService.processDocument(announceId, applicationId, docId);

			if (!docResult.success || !docResult.signedDocument) {
				throw new Error(docResult.error || 'Не удалось получить подписанный документ');
			}

			if (!docResult.fileIdentifier) {
				throw new Error('Не удалось получить fileIdentifier из processDocument');
			}

			const fileIdentifier = docResult.fileIdentifier;
			this.logger.log(`[${docId}] Подписанный документ получен, fileIdentifier: ${fileIdentifier}`);

			// Шаг 3: Получить подпись из подписанного документа
			// Для XML файлов подпись уже включена в документ, нужно извлечь её
			// Для других файлов подпись может быть отдельно
			let signature: string;

			if (typeof docResult.signedDocument === 'string') {
				// Для XML - извлекаем подпись из XML
				const xmlContent = docResult.signedDocument;
				// Ищем тег <ds:SignatureValue> или <SignatureValue>
				const signatureMatch = xmlContent.match(/<[^:]*:?SignatureValue[^>]*>([^<]+)<\/[^:]*:?SignatureValue>/i);
				if (signatureMatch && signatureMatch[1]) {
					signature = signatureMatch[1].trim();
				} else {
					// Если не нашли, используем весь XML как подпись (base64)
					signature = Buffer.from(xmlContent, 'utf-8').toString('base64');
				}
			} else {
				// Для бинарных файлов - конвертируем Buffer в base64
				signature = docResult.signedDocument.toString('base64');
			}

			this.logger.log(`[${docId}] Подпись извлечена, длина: ${signature.length}`);

			// Шаг 4: Отправить подписанный документ на сервер
			this.logger.log(`[${docId}] Отправка подписанного документа на сервер...`);
			const uploadUrl = `/ru/application/show_doc/${announceId}/${applicationId}/${docId}`;

			// Формируем FormData согласно примеру:
			// userfile[1356]=288337870&save_form=&signature[288337870]=MIIHEQYJ...
			const formData: Record<string, any> = {
				[`userfile[${docId}]`]: fileIdentifier,
				'save_form': '',
				[`signature[${fileIdentifier}]`]: signature,
			};

			const uploadResponse = await this.portalService.request({
				url: uploadUrl,
				method: 'POST',
				isFormData: true,
				data: formData,
				additionalHeaders: {
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'Referer': `https://v3bl.goszakup.gov.kz${uploadUrl}`,
				}
			});
			
			await this.portalService.request({
				url: uploadUrl,
				method: 'POST',
				isFormData: true,
				data: formData,
				additionalHeaders: {
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'Referer': `https://v3bl.goszakup.gov.kz${uploadUrl}`,
				}
			});

			this.logger.log(`[${docId}] Подписанный документ отправлен. Статус: ${uploadResponse.status}`);

			return {
				success: uploadResponse.success,
				status: uploadResponse.status,
				fileIdentifier,
				docId,
				response: uploadResponse.data,
			};
		} catch (error) {
			this.logger.error(`Ошибка при обработке документа ${docId}: ${(error as Error).message}`);
			throw error;
		}
	}

	/**
	 * Обработка документа с предварительным запросом на формирование
	 * Используется для документов, где сначала нужно отправить generate=&userfile[docId]=&save_form=
	 */
	// async handleDocumentWithInitialRequest(announceId: string, applicationId: string, docId: string): Promise<any> {
	// 	this.logger.log(`Обработка документа ${docId} с предварительным запросом для заявки ${applicationId}...`);
	//
	// 	try {
	// 		// Шаг 1: Отправить запрос на формирование документа с параметрами generate=&userfile[docId]=&save_form=
	// 		this.logger.log(`[${docId}] Отправка запроса на формирование документа...`);
	// 		const formUrl = `/ru/application/show_doc/${announceId}/${applicationId}/${docId}`;
	//
	// 		const formResponse = await this.portalService.request({
	// 			url: formUrl,
	// 			method: 'POST',
	// 			isFormData: true,
	// 			data: {
	// 				generate: '',
	// 				[`userfile[${docId}]`]: '',
	// 				save_form: '',
	// 			},
	// 			additionalHeaders: {
	// 				'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
	// 				'Content-Type': 'application/x-www-form-urlencoded',
	// 				'Referer': `https://v3bl.goszakup.gov.kz${formUrl}`,
	// 			}
	// 		});
	//
	// 		this.logger.log(`[${docId}] Запрос на формирование документа отправлен. Статус: ${formResponse.status}`);
	//
	// 		// Шаг 2: Извлечь fileUrl и fileIdentifier из HTML ответа
	// 		let fileIdentifier: string | null = null;
	// 		let fileUrl: string | null = null;
	//
	// 		if (formResponse.data && typeof formResponse.data === 'string') {
	// 			const html = formResponse.data as string;
	//
	// 			// Диагностика: логируем фрагмент HTML для отладки
	// 			const htmlPreview = html.substring(0, 15000);
	// 			this.logger.debug(`[${docId}] HTML превью ответа (первые 15000 символов): ${htmlPreview}`);
	//
	// 			// Извлекаем data-url
	// 			const dataUrlMatch = html.match(/data-url=["']([^"']+)["']/i);
	// 			if (dataUrlMatch && dataUrlMatch[1]) {
	// 				fileUrl = dataUrlMatch[1];
	// 				this.logger.debug(`[${docId}] Найден data-url: ${fileUrl}`);
	// 			}
	//
	// 			// Извлекаем fileIdentifier
	// 			const idMatch = html.match(/data-file-identifier=["']([^"']+)["']/i);
	// 			if (idMatch && idMatch[1]) {
	// 				fileIdentifier = idMatch[1];
	// 				this.logger.debug(`[${docId}] Найден fileIdentifier: ${fileIdentifier}`);
	// 			}
	//
	// 			// Если data-url нет, пробуем другие паттерны
	// 			if (!fileUrl) {
	// 				// Паттерн 1: href с download
	// 				const hrefMatch = html.match(/href\s*=\s*["']([^"']+download[^"']*)["']/i);
	// 				if (hrefMatch && hrefMatch[1]) {
	// 					fileUrl = hrefMatch[1];
	// 					this.logger.debug(`[${docId}] Найден href с download: ${fileUrl}`);
	// 				}
	//
	// 				// Паттерн 2: href с download_file
	// 				if (!fileUrl) {
	// 					const downloadFileMatch = html.match(/href\s*=\s*["']([^"']+download_file[^"']*)["']/i);
	// 					if (downloadFileMatch && downloadFileMatch[1]) {
	// 						fileUrl = downloadFileMatch[1];
	// 						this.logger.debug(`[${docId}] Найден href с download_file: ${fileUrl}`);
	// 					}
	// 				}
	//
	// 				// Паттерн 3: ссылка в таблице
	// 				if (!fileUrl) {
	// 					const tableLinkMatch = html.match(/<a[^>]*href=["']([^"']+download_file\/\d+\/)["'][^>]*>/i);
	// 					if (tableLinkMatch && tableLinkMatch[1]) {
	// 						fileUrl = tableLinkMatch[1];
	// 						this.logger.debug(`[${docId}] Найден ссылка в таблице: ${fileUrl}`);
	// 					}
	// 				}
	// 			}
	//
	// 			// Диагностика: проверяем наличие ключевых элементов
	// 			const hasAddSignatureBlock = html.includes('add_signature_block');
	// 			const hasBtnAddSignature = html.includes('btn-add-signature');
	// 			const hasDataUrl = html.includes('data-url');
	// 			const hasDownloadFile = html.includes('download_file');
	// 			const hasTable = html.includes('<table') || html.includes('<tbody>');
	// 			const hasGreenCheck = html.includes('glyphicon-check') && html.includes('color: green');
	//
	// 			this.logger.debug(`[${docId}] Диагностика HTML: hasAddSignatureBlock=${hasAddSignatureBlock}, hasBtnAddSignature=${hasBtnAddSignature}, hasDataUrl=${hasDataUrl}, hasDownloadFile=${hasDownloadFile}, hasTable=${hasTable}, hasGreenCheck=${hasGreenCheck}`);
	//
	// 			// Если файл уже подписан (есть зеленая галочка), это не ошибка
	// 			if (hasGreenCheck && !fileUrl) {
	// 				this.logger.log(`[${docId}] Файл уже подписан (есть зеленая галочка). Пропускаем скачивание и подписание.`);
	// 				return {
	// 					fileUrl: null,
	// 					fileIdentifier: null,
	// 					alreadySigned: true,
	// 				};
	// 			}
	// 		}
	//
	// 		if (!fileUrl) {
	// 			// Логируем больше информации для отладки
	// 			if (formResponse.data && typeof formResponse.data === 'string') {
	// 				const html = formResponse.data as string;
	// 				const errorPreview = html.substring(0, 5000);
	// 				this.logger.error(`[${docId}] Не удалось получить ссылку на файл из ответа. HTML превью: ${errorPreview}`);
	// 			} else {
	// 				this.logger.error(`[${docId}] Не удалось получить ссылку на файл из ответа. Тип данных: ${typeof formResponse.data}`);
	// 			}
	// 			throw new Error('Не удалось получить ссылку на файл из ответа');
	// 		}
	//
	// 		if (!fileIdentifier) {
	// 			throw new Error('Не удалось получить fileIdentifier из ответа');
	// 		}
	//
	// 		this.logger.log(`[${docId}] Ссылка на файл получена: ${fileUrl}, fileIdentifier: ${fileIdentifier}`);
	//
	// 		// Шаг 3: Скачать файл
	// 		this.logger.log(`[${docId}] Скачивание файла...`);
	// 		downloadedFilePath = await this.downloadFile(fileUrl, docId);
	// 		this.logger.log(`[${docId}] Файл скачан: ${downloadedFilePath}`);
	//
	// 		// Шаг 4: Подписать файл
	// 		this.logger.log(`[${docId}] Подписание файла...`);
	// 		signedFilePath = await this.signFile(downloadedFilePath, docId);
	// 		this.logger.log(`[${docId}] Файл подписан: ${signedFilePath}`);
	//
	// 		// Шаг 5: Извлечь подпись из подписанного файла
	// 		const signedFileBuffer = await fs.readFile(signedFilePath);
	// 		let signature: string;
	//
	// 		const ext = path.extname(signedFilePath).toLowerCase();
	// 		if (ext === '.xml') {
	// 			const xmlContent = signedFileBuffer.toString('utf-8');
	// 			const signatureMatch = xmlContent.match(/<[^:]*:?SignatureValue[^>]*>([^<]+)<\/[^:]*:?SignatureValue>/i);
	// 			if (signatureMatch && signatureMatch[1]) {
	// 				signature = signatureMatch[1].trim();
	// 			} else {
	// 				signature = Buffer.from(xmlContent, 'utf-8').toString('base64');
	// 			}
	// 		} else {
	// 			signature = signedFileBuffer.toString('base64');
	// 		}
	//
	// 		this.logger.log(`[${docId}] Подпись извлечена, длина: ${signature.length}`);
	//
	// 		// Шаг 6: Отправить подписанный документ на сервер
	// 		this.logger.log(`[${docId}] Отправка подписанного документа на сервер...`);
	// 		const uploadUrl = `/ru/application/show_doc/${announceId}/${applicationId}/${docId}`;
	//
	// 		const formData: Record<string, any> = {
	// 			[`userfile[${docId}]`]: fileIdentifier,
	// 			'save_form': '',
	// 			[`signature[${fileIdentifier}]`]: signature,
	// 		};
	//
	// 		const uploadResponse = await this.portalService.request({
	// 			url: uploadUrl,
	// 			method: 'POST',
	// 			isFormData: true,
	// 			data: formData,
	// 			additionalHeaders: {
	// 				'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
	// 				'Referer': `https://v3bl.goszakup.gov.kz${uploadUrl}`,
	// 			}
	// 		});
	//
	// 		this.logger.log(`[${docId}] Подписанный документ отправлен. Статус: ${uploadResponse.status}`);
	//
	// 		return {
	// 			success: uploadResponse.success,
	// 			status: uploadResponse.status,
	// 			fileIdentifier,
	// 			docId,
	// 			response: uploadResponse.data,
	// 		};
	// 	} catch (error) {
	// 		this.logger.error(`Ошибка при обработке документа ${docId}: ${(error as Error).message}`);
	// 		throw error;
	// 	}
	// }

	/**
	 * Скачать файл по URL в память (Buffer) с кэшированием в Redis
	 * Возвращает Buffer и расширение файла
	 */
	async downloadFile(fileUrl: string, taskId: string): Promise<{ fileBuffer: Buffer; ext: string }> {
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
						ext: cachedData.ext,
					};
				}
			}
			
			// Если нет в кэше, скачиваем
			const baseURL = this.configService.get<string>('PORTAL_BASE_URL', 'https://v3bl.goszakup.gov.kz');
			const fullUrl = fileUrl.startsWith('http') ? fileUrl : `${baseURL}${fileUrl}`;
			
			this.logger.debug(`[${taskId}] Скачивание файла с ${fullUrl}`);
			
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
				else if (contentType.includes('xml') && contentType.includes('text/xml') || contentType.includes('application/xml')) ext = '.xml';
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
			
			this.logger.debug(`[${taskId}] Определено расширение файла: ${ext} (URL: ${fileUrl}, Content-Type: ${response.headers['content-type'] || 'не указан'})`);
			
			// Кэшируем в Redis только если файл небольшой
			if (this.enableFileCache && fileBuffer.length <= this.maxCacheSize) {
				const cacheData = {
					data: fileBuffer.toString('base64'),
					ext,
				};
				await this.redisService.set(cacheKey, JSON.stringify(cacheData), this.fileCacheTtl);
				this.logger.debug(`[${taskId}] Файл сохранен в кэш Redis: ${fileUrl} (${fileBuffer.length} байт)`);
			} else if (fileBuffer.length > this.maxCacheSize) {
				this.logger.debug(`[${taskId}] Файл слишком большой для кэширования: ${fileBuffer.length} байт`);
			}
			
			return { fileBuffer, ext };
		} catch (error) {
			this.logger.error(`[${taskId}] Ошибка скачивания файла: ${(error as Error).message}`);
			throw error;
		}
	}

	/**
	 * Подписать файл через ncanode
	 * Принимает Buffer и расширение файла, возвращает Buffer или string
	 * @param fileUrl - опциональный URL файла для удаления оригинального файла из кэша после подписания
	 */
	async signFile(fileBuffer: Buffer, ext: string, taskId: string, fileUrl?: string): Promise<Buffer | string> {
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
	 * Обработка документа с параметрами bankruptcy и btn=docGen/docSave
	 */
	async handleDocumentWithBankruptcy(announceId: string, applicationId: string, docId: string, bankruptcy: string = '2'): Promise<any> {
		this.logger.log(`Обработка документа ${docId} с параметром bankruptcy для заявки ${applicationId}...`);

		try {
			// Шаг 1: Отправить запрос на формирование документа с bankruptcy=2&btn=docGen
			this.logger.log(`[${docId}] Отправка запроса на формирование документа (bankruptcy=${bankruptcy})...`);
			const docUrl = `/ru/application/show_doc/${announceId}/${applicationId}/${docId}`;
			
			const genResponse = await this.portalService.request({
				url: docUrl,
				method: 'POST',
				isFormData: true,
				data: {
					bankruptcy: bankruptcy,
					btn: 'docGen',
				},
				additionalHeaders: {
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'Referer': `https://v3bl.goszakup.gov.kz${docUrl}`,
				}
			});

			this.logger.log(`[${docId}] Запрос на формирование документа отправлен. Статус: ${genResponse.status}`);

			if (!genResponse.success || !genResponse.data || typeof genResponse.data !== 'string') {
				throw new Error('Не удалось получить HTML ответ от сервера');
			}

			// Шаг 2: Извлечь data-url и data-file-identifier из HTML
			const html = genResponse.data as string;
			let fileUrl: string | null = null;
			let fileIdentifier: string | null = null;

			// Извлекаем data-url из кнопки
			const dataUrlMatch = html.match(/data-url=["']([^"']+)["']/i);
			if (dataUrlMatch && dataUrlMatch[1]) {
				fileUrl = dataUrlMatch[1];
			}

			// Извлекаем data-file-identifier
			const dataIdMatch = html.match(/data-file-identifier=["']([^"']+)["']/i);
			if (dataIdMatch && dataIdMatch[1]) {
				fileIdentifier = dataIdMatch[1];
			}

			if (!fileUrl) {
				throw new Error('Не удалось получить data-url из HTML ответа');
			}

			if (!fileIdentifier) {
				throw new Error('Не удалось получить data-file-identifier из HTML ответа');
			}

			this.logger.log(`[${docId}] Ссылка на файл получена: ${fileUrl}, fileIdentifier: ${fileIdentifier}`);

			// Шаг 3: Скачать файл
			this.logger.log(`[${docId}] Скачивание файла...`);
			const { fileBuffer, ext } = await this.downloadFile(fileUrl, docId);
			this.logger.log(`[${docId}] Файл скачан в память (${fileBuffer.length} байт)`);

			// Шаг 4: Подписать файл
			this.logger.log(`[${docId}] Подписание файла...`);
			const signedDocument = await this.signFile(fileBuffer, ext, docId, fileUrl);
			this.logger.log(`[${docId}] Файл подписан`);

			// Шаг 5: Извлечь подпись из подписанного файла
			let signature: string;

			if (ext === '.xml') {
				const xmlContent = typeof signedDocument === 'string' ? signedDocument : signedDocument.toString('utf-8');
				const signatureMatch = xmlContent.match(/<[^:]*:?SignatureValue[^>]*>([^<]+)<\/[^:]*:?SignatureValue>/i);
				if (signatureMatch && signatureMatch[1]) {
					signature = signatureMatch[1].trim();
				} else {
					signature = typeof signedDocument === 'string' 
						? Buffer.from(xmlContent, 'utf-8').toString('base64')
						: signedDocument.toString('base64');
				}
			} else {
				signature = typeof signedDocument === 'string'
					? Buffer.from(signedDocument, 'utf-8').toString('base64')
					: signedDocument.toString('base64');
			}

			this.logger.log(`[${docId}] Подпись извлечена, длина: ${signature.length}`);

			// Шаг 6: Отправить подписанный документ на сервер
			this.logger.log(`[${docId}] Отправка подписанного документа на сервер...`);

			const formData: Record<string, any> = {
				btn: 'docSave',
				[`signature[${fileIdentifier}]`]: signature,
			};

			const saveResponse = await this.portalService.request({
				url: docUrl,
				method: 'POST',
				isFormData: true,
				data: formData,
				additionalHeaders: {
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'Referer': `https://v3bl.goszakup.gov.kz${docUrl}`,
				}
			});

			this.logger.log(`[${docId}] Подписанный документ отправлен. Статус: ${saveResponse.status}`);

			return {
				success: saveResponse.success,
				status: saveResponse.status,
				fileIdentifier,
				docId,
				response: saveResponse.data,
			};
		} catch (error) {
			this.logger.error(`Ошибка при обработке документа ${docId}: ${(error as Error).message}`);
			throw error;
		}
	}
}

