import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApplicationService } from '../application/application.service';
import { PortalService } from '../portal/portal.service';
import { HttpService } from '../http/http.service';
import { NcanodeService } from '../ncanode/ncanode.service';
import { Buffer } from 'buffer';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

@Injectable()
export class AppendixService {
	private readonly logger = new Logger(AppendixService.name);
	private readonly tempDir: string;

	constructor(
		private applicationService: ApplicationService,
		private portalService: PortalService,
		private configService: ConfigService,
		private httpService: HttpService,
		private ncanodeService: NcanodeService,
	) {
		// Создаем временную директорию для файлов
		this.tempDir = path.join(os.tmpdir(), 'goszakup-docs');
		this.ensureTempDir();
	}

	private async ensureTempDir(): Promise<void> {
		try {
			await fs.mkdir(this.tempDir, { recursive: true });
		} catch (error) {
			this.logger.error(`Ошибка создания временной директории: ${(error as Error).message}`);
		}
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
	async handleDocumentWithInitialRequest(announceId: string, applicationId: string, docId: string): Promise<any> {
		this.logger.log(`Обработка документа ${docId} с предварительным запросом для заявки ${applicationId}...`);

		let downloadedFilePath: string | null = null;
		let signedFilePath: string | null = null;

		try {
			// Шаг 1: Отправить запрос на формирование документа с параметрами generate=&userfile[docId]=&save_form=
			this.logger.log(`[${docId}] Отправка запроса на формирование документа...`);
			const formUrl = `/ru/application/show_doc/${announceId}/${applicationId}/${docId}`;
			
			const formResponse = await this.portalService.request({
				url: formUrl,
				method: 'POST',
				isFormData: true,
				data: {
					generate: '',
					[`userfile[${docId}]`]: '',
					save_form: '',
				},
				additionalHeaders: {
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'Content-Type': 'application/x-www-form-urlencoded',
					'Referer': `https://v3bl.goszakup.gov.kz${formUrl}`,
				}
			});

			this.logger.log(`[${docId}] Запрос на формирование документа отправлен. Статус: ${formResponse.status}`);

			// Шаг 2: Извлечь fileUrl и fileIdentifier из HTML ответа
			let fileIdentifier: string | null = null;
			let fileUrl: string | null = null;

			if (formResponse.data && typeof formResponse.data === 'string') {
				const html = formResponse.data as string;
				
				// Диагностика: логируем фрагмент HTML для отладки
				const htmlPreview = html.substring(0, 15000);
				this.logger.debug(`[${docId}] HTML превью ответа (первые 15000 символов): ${htmlPreview}`);

				// Извлекаем data-url
				const dataUrlMatch = html.match(/data-url=["']([^"']+)["']/i);
				if (dataUrlMatch && dataUrlMatch[1]) {
					fileUrl = dataUrlMatch[1];
					this.logger.debug(`[${docId}] Найден data-url: ${fileUrl}`);
				}

				// Извлекаем fileIdentifier
				const idMatch = html.match(/data-file-identifier=["']([^"']+)["']/i);
				if (idMatch && idMatch[1]) {
					fileIdentifier = idMatch[1];
					this.logger.debug(`[${docId}] Найден fileIdentifier: ${fileIdentifier}`);
				}

				// Если data-url нет, пробуем другие паттерны
				if (!fileUrl) {
					// Паттерн 1: href с download
					const hrefMatch = html.match(/href\s*=\s*["']([^"']+download[^"']*)["']/i);
					if (hrefMatch && hrefMatch[1]) {
						fileUrl = hrefMatch[1];
						this.logger.debug(`[${docId}] Найден href с download: ${fileUrl}`);
					}
					
					// Паттерн 2: href с download_file
					if (!fileUrl) {
						const downloadFileMatch = html.match(/href\s*=\s*["']([^"']+download_file[^"']*)["']/i);
						if (downloadFileMatch && downloadFileMatch[1]) {
							fileUrl = downloadFileMatch[1];
							this.logger.debug(`[${docId}] Найден href с download_file: ${fileUrl}`);
						}
					}
					
					// Паттерн 3: ссылка в таблице
					if (!fileUrl) {
						const tableLinkMatch = html.match(/<a[^>]*href=["']([^"']+download_file\/\d+\/)["'][^>]*>/i);
						if (tableLinkMatch && tableLinkMatch[1]) {
							fileUrl = tableLinkMatch[1];
							this.logger.debug(`[${docId}] Найден ссылка в таблице: ${fileUrl}`);
						}
					}
				}
				
				// Диагностика: проверяем наличие ключевых элементов
				const hasAddSignatureBlock = html.includes('add_signature_block');
				const hasBtnAddSignature = html.includes('btn-add-signature');
				const hasDataUrl = html.includes('data-url');
				const hasDownloadFile = html.includes('download_file');
				const hasTable = html.includes('<table') || html.includes('<tbody>');
				const hasGreenCheck = html.includes('glyphicon-check') && html.includes('color: green');
				
				this.logger.debug(`[${docId}] Диагностика HTML: hasAddSignatureBlock=${hasAddSignatureBlock}, hasBtnAddSignature=${hasBtnAddSignature}, hasDataUrl=${hasDataUrl}, hasDownloadFile=${hasDownloadFile}, hasTable=${hasTable}, hasGreenCheck=${hasGreenCheck}`);
				
				// Если файл уже подписан (есть зеленая галочка), это не ошибка
				if (hasGreenCheck && !fileUrl) {
					this.logger.log(`[${docId}] Файл уже подписан (есть зеленая галочка). Пропускаем скачивание и подписание.`);
					return {
						fileUrl: null,
						fileIdentifier: null,
						alreadySigned: true,
					};
				}
			}

			if (!fileUrl) {
				// Логируем больше информации для отладки
				if (formResponse.data && typeof formResponse.data === 'string') {
					const html = formResponse.data as string;
					const errorPreview = html.substring(0, 5000);
					this.logger.error(`[${docId}] Не удалось получить ссылку на файл из ответа. HTML превью: ${errorPreview}`);
				} else {
					this.logger.error(`[${docId}] Не удалось получить ссылку на файл из ответа. Тип данных: ${typeof formResponse.data}`);
				}
				throw new Error('Не удалось получить ссылку на файл из ответа');
			}

			if (!fileIdentifier) {
				throw new Error('Не удалось получить fileIdentifier из ответа');
			}

			this.logger.log(`[${docId}] Ссылка на файл получена: ${fileUrl}, fileIdentifier: ${fileIdentifier}`);

			// Шаг 3: Скачать файл
			this.logger.log(`[${docId}] Скачивание файла...`);
			downloadedFilePath = await this.downloadFile(fileUrl, docId);
			this.logger.log(`[${docId}] Файл скачан: ${downloadedFilePath}`);

			// Шаг 4: Подписать файл
			this.logger.log(`[${docId}] Подписание файла...`);
			signedFilePath = await this.signFile(downloadedFilePath, docId);
			this.logger.log(`[${docId}] Файл подписан: ${signedFilePath}`);

			// Шаг 5: Извлечь подпись из подписанного файла
			const signedFileBuffer = await fs.readFile(signedFilePath);
			let signature: string;

			const ext = path.extname(signedFilePath).toLowerCase();
			if (ext === '.xml') {
				const xmlContent = signedFileBuffer.toString('utf-8');
				const signatureMatch = xmlContent.match(/<[^:]*:?SignatureValue[^>]*>([^<]+)<\/[^:]*:?SignatureValue>/i);
				if (signatureMatch && signatureMatch[1]) {
					signature = signatureMatch[1].trim();
				} else {
					signature = Buffer.from(xmlContent, 'utf-8').toString('base64');
				}
			} else {
				signature = signedFileBuffer.toString('base64');
			}

			this.logger.log(`[${docId}] Подпись извлечена, длина: ${signature.length}`);

			// Шаг 6: Отправить подписанный документ на сервер
			this.logger.log(`[${docId}] Отправка подписанного документа на сервер...`);
			const uploadUrl = `/ru/application/show_doc/${announceId}/${applicationId}/${docId}`;

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

			this.logger.log(`[${docId}] Подписанный документ отправлен. Статус: ${uploadResponse.status}`);

			// Очистка временных файлов
			await this.cleanupFiles([downloadedFilePath, signedFilePath]);

			return {
				success: uploadResponse.success,
				status: uploadResponse.status,
				fileIdentifier,
				docId,
				response: uploadResponse.data,
			};
		} catch (error) {
			// Очистка временных файлов при ошибке
			if (downloadedFilePath) {
				await this.cleanupFiles([downloadedFilePath]);
			}
			if (signedFilePath) {
				await this.cleanupFiles([signedFilePath]);
			}
			this.logger.error(`Ошибка при обработке документа ${docId}: ${(error as Error).message}`);
			throw error;
		}
	}

	/**
	 * Скачать файл по URL
	 */
	async downloadFile(fileUrl: string, taskId: string): Promise<string> {
		try {
			const baseURL = this.configService.get<string>('PORTAL_BASE_URL', 'https://v3bl.goszakup.gov.kz');
			const fullUrl = fileUrl.startsWith('http') ? fileUrl : `${baseURL}${fileUrl}`;
			
			this.logger.debug(`[${taskId}] Скачивание файла с ${fullUrl}`);
			
			const response = await this.httpService.get(fileUrl, {
				responseType: 'arraybuffer',
				timeout: 60000,
			});
			
			const contentType = response.headers['content-type'] || '';
			let ext = '.tmp';
			if (contentType.includes('pdf')) ext = '.pdf';
			else if (contentType.includes('xml')) ext = '.xml';
			else if (contentType.includes('doc')) ext = '.doc';
			else if (contentType.includes('zip')) ext = '.zip';
			
			const fileName = `${taskId}-${Date.now()}${ext}`;
			const filePath = path.join(this.tempDir, fileName);
			
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
	async signFile(filePath: string, taskId: string): Promise<string> {
		try {
			const fileBuffer = await fs.readFile(filePath);
			
			const certPath = this.configService.get<string>('CERT_PATH', '');
			const certPassword = this.configService.get<string>('CERT_PASSWORD', '');
			
			if (!certPath || !certPassword) {
				throw new Error('Не указан путь к сертификату или пароль');
			}
			
			const ext = path.extname(filePath).toLowerCase();
			let signedData: any;
			
			if (ext === '.xml') {
				const xmlContent = fileBuffer.toString('utf-8');
				signedData = await this.ncanodeService.signWithNclayer(xmlContent, certPath, certPassword);
			} else {
				signedData = await this.ncanodeService.sign(fileBuffer, certPath, certPassword, true);
			}
			
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
	 * Обработка документа с параметрами bankruptcy и btn=docGen/docSave
	 */
	async handleDocumentWithBankruptcy(announceId: string, applicationId: string, docId: string, bankruptcy: string = '2'): Promise<any> {
		this.logger.log(`Обработка документа ${docId} с параметром bankruptcy для заявки ${applicationId}...`);

		let downloadedFilePath: string | null = null;
		let signedFilePath: string | null = null;

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
			downloadedFilePath = await this.downloadFile(fileUrl, docId);
			this.logger.log(`[${docId}] Файл скачан: ${downloadedFilePath}`);

			// Шаг 4: Подписать файл
			this.logger.log(`[${docId}] Подписание файла...`);
			signedFilePath = await this.signFile(downloadedFilePath, docId);
			this.logger.log(`[${docId}] Файл подписан: ${signedFilePath}`);

			// Шаг 5: Извлечь подпись из подписанного файла
			const signedFileBuffer = await fs.readFile(signedFilePath);
			let signature: string;

			const ext = path.extname(signedFilePath).toLowerCase();
			if (ext === '.xml') {
				const xmlContent = signedFileBuffer.toString('utf-8');
				const signatureMatch = xmlContent.match(/<[^:]*:?SignatureValue[^>]*>([^<]+)<\/[^:]*:?SignatureValue>/i);
				if (signatureMatch && signatureMatch[1]) {
					signature = signatureMatch[1].trim();
				} else {
					signature = Buffer.from(xmlContent, 'utf-8').toString('base64');
				}
			} else {
				signature = signedFileBuffer.toString('base64');
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

			// Очистка временных файлов
			await this.cleanupFiles([downloadedFilePath, signedFilePath]);

			return {
				success: saveResponse.success,
				status: saveResponse.status,
				fileIdentifier,
				docId,
				response: saveResponse.data,
			};
		} catch (error) {
			// Очистка временных файлов при ошибке
			if (downloadedFilePath) {
				await this.cleanupFiles([downloadedFilePath]);
			}
			if (signedFilePath) {
				await this.cleanupFiles([signedFilePath]);
			}
			this.logger.error(`Ошибка при обработке документа ${docId}: ${(error as Error).message}`);
			throw error;
		}
	}

	/**
	 * Очистка временных файлов
	 */
	async cleanupFiles(filePaths: (string | null)[]): Promise<void> {
		for (const filePath of filePaths) {
			if (filePath) {
				try {
					await fs.unlink(filePath);
				} catch (error) {
					this.logger.warn(`Не удалось удалить временный файл ${filePath}: ${(error as Error).message}`);
				}
			}
		}
	}
}

