import {Inject, Injectable, Logger, forwardRef} from '@nestjs/common';
import {ApplicationService} from "../application/application.service";
import {AuthService} from "../auth/auth.service";
import {AppendixService} from "./appendix.service";
import {IPortalProcessor} from './portal-processor.interface';
import {PortalService} from '../portal/portal.service';
import {HtmlParserService} from './html-parser.service';
import {CryptoSocketService} from '../ncanode/crypto-socket.service';
import {NcanodeService} from '../ncanode/ncanode.service';
import {NclayerService} from '../ncanode/nclayer.service';
import {ConfigService} from '@nestjs/config';
import { Buffer } from 'buffer';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as cheerio from 'cheerio';
import axios from 'axios';

/**
 * Сервис для обработки данных портала
 * Реализует интерфейс IPortalProcessor
 */
@Injectable()
export class PortalProcessorService implements IPortalProcessor {
	private readonly logger = new Logger(PortalProcessorService.name);
	
	constructor(
		private portalService: PortalService,
		private htmlParserService: HtmlParserService,
		@Inject(forwardRef(() => ApplicationService))
		private applicationService: ApplicationService,
		private appendixService: AppendixService,
		private cryptoSocketService: CryptoSocketService,
		private ncanodeService: NcanodeService,
		private nclayerService: NclayerService,
		private configService: ConfigService,
		private authService: AuthService,
	) {
		// Регистрируем callback для обработки результата EncryptOfferPrice
		this.cryptoSocketService.setEncryptOfferPriceCallback((response, context) => {
			return this.handleEncryptOfferPriceResult(response, context);
		});
	}
	
	
	/**
	 * Вспомогательный метод для выполнения запроса с повторными попытками
	 * @param requestFn - Функция для выполнения запроса
	 * @param taskId - ID задачи для логирования
	 * @param maxRetries - Максимальное количество попыток (по умолчанию 3)
	 * @param retryDelay - Задержка между попытками в мс (по умолчанию 1000)
	 * @returns Результат запроса
	 */
	private async retryRequest<T>(
		requestFn: () => Promise<T>,
		taskId: string,
		maxRetries: number = 3,
		retryDelay: number = 1000
	): Promise<T> {
		let lastError: Error | null = null;
		
		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				return await requestFn();
			} catch (error) {
				lastError = error as Error;
				this.logger.warn(`[${taskId}] Попытка ${attempt}/${maxRetries} не удалась: ${lastError.message}`);
				
				if (attempt < maxRetries) {
					this.logger.log(`[${taskId}] Повторная попытка через ${retryDelay}мс...`);
					await new Promise(resolve => setTimeout(resolve, retryDelay));
					// Увеличиваем задержку для следующей попытки (exponential backoff)
					retryDelay *= 1.5;
				}
			}
		}
		
		// Если все попытки не удались, выбрасываем последнюю ошибку
		throw lastError || new Error('Неизвестная ошибка при выполнении запроса');
	}
	
	/**
	 * Вспомогательный метод для проверки авторизации и переавторизации при необходимости
	 * @param html - HTML ответ от сервера
	 * @param response - Объект ответа от portalService.request
	 * @param taskId - ID задачи для логирования
	 * @param url - URL запроса для повторного запроса
	 * @param additionalHeaders - Дополнительные заголовки для повторного запроса
	 * @returns Обновленный HTML или null, если требуется повторный запрос
	 */
	private async checkAndReauthIfNeeded(
		html: string,
		response: any,
		taskId: string,
		url: string,
		additionalHeaders?: Record<string, string>
	): Promise<string | null> {
		// Проверяем, не является ли это страницей авторизации используя cheerio
		let isAuthPage = false;
		try {
			const $ = cheerio.load(html);
			const title = $('title').text().trim();
			isAuthPage = title.includes('Авторизация') ||
				html.includes('/user/auth') ||
				html.includes('/user/login') ||
				response.redirectedToAuth;
		} catch (error) {
			// Fallback на старый метод
			isAuthPage = html.includes('<title>Авторизация</title>') ||
				html.includes('/user/auth') ||
				html.includes('/user/login') ||
				response.redirectedToAuth;
		}
		
		if (isAuthPage) {
			this.logger.warn(`[${taskId}] Получена страница авторизации, сессия истекла. Выполняем переавторизацию...`);
			
			try {
				// Выполняем переавторизацию с повторными попытками
				const authSuccess = await this.retryRequest(
					async () => {
						const result = await this.authService.login(true);
						if (!result) {
							throw new Error('Авторизация не удалась');
						}
						return result;
					},
					`${taskId}-auth`,
					3,
					1000
				);
				
				// Повторяем запрос после авторизации с повторными попытками
				this.logger.log(`[${taskId}] Повторный запрос после авторизации...`);
				const retryResponse = await this.retryRequest(
					async () => {
						const resp = await this.portalService.request({
							url: url,
							method: 'GET',
							additionalHeaders: additionalHeaders || {},
						});
						
						if (!resp.success || !resp.data || typeof resp.data !== 'string') {
							throw new Error('Не удалось получить HTML после переавторизации');
						}
						
						const retryHtml = resp.data as string;
						
						// Проверяем еще раз
						if (retryHtml.includes('<title>Авторизация</title>') ||
							retryHtml.includes('/user/auth') ||
							retryHtml.includes('/user/login') ||
							resp.redirectedToAuth) {
							throw new Error('После переавторизации все еще получаем страницу авторизации');
						}
						
						return {response: resp, html: retryHtml};
					},
					`${taskId}-retry`,
					3,
					1000
				);
				
				this.logger.log(`[${taskId}] Переавторизация успешна, используем новый HTML`);
				return retryResponse.html;
			} catch (error) {
				// Если произошла ошибка при переавторизации, логируем и продолжаем работу
				this.logger.error(`[${taskId}] Ошибка при переавторизации после всех попыток: ${(error as Error).message}. Продолжаем работу с исходным HTML`);
				return null; // Возвращаем null, чтобы использовать исходный HTML
			}
		}
		
		return null; // Авторизация не требуется
	}
	
	/**
	 * Обработать данные о налоговой задолженности
	 */
	
	async processUpdateInformationOnTaxArrears(): Promise<any> {
		this.logger.log('Обработка обновления информации о налоговой задолженности...');
		
		try {
			// Используем метод из PortalService для отправки запроса
			const response = await this.portalService.request({
				url: '/ru/cabinet/tax_debts',
				method: 'POST',
				isFormData: true,
				data: {
					send_request: 'Получить новые сведения',
				},
			});
			this.logger.log(`Обработка завершена. Успех: ${response.success}, Статус: ${response.status}`);
			
			return {
				...response,
				processed: true,
			};
		} catch (error) {
			this.logger.error(`Ошибка при обновлении информации о налоговой задолженности: ${(error as Error).message}`);
			throw error;
		}
	}
	
	
	/**
	 * Получение разрешительных документов
	 */
	async processGetPermits(data: any): Promise<any> {
		this.logger.log('Обработка получения разрешительных документов...');
		
		try {
			// Параметры по умолчанию, если они не переданы в data
			const defaultParams = {
				'filter[nikad]': 'НИКА',
				'filter[date_issue]': '',
				'request[type]': '1',
				'request[text]': 'KZ35VWC00252553',
				'request[date_issue]': '',
				'get_permit': 'Получить разрешения ',
				'type': 'permit',
			};
			
			// Объединяем параметры по умолчанию с переданными данными
			// Переданные данные имеют приоритет
			const requestData = {
				...defaultParams,
				...data,
			};
			
			// Используем метод из PortalService для отправки запроса
			const response = await this.portalService.request({
				url: '/ru/cabinet/permits',
				method: 'POST',
				isFormData: true,
				data: requestData,
			});
			
			this.logger.log(`Обработка завершена. Успех: ${response.success}, Статус: ${response.status}`);
			
			return {
				...response,
				processed: true,
			};
		} catch (error) {
			this.logger.error(`Ошибка при получения разрешительных документов: ${(error as Error).message}`);
			throw error;
		}
	}
	
	/**
	 * Поиск объявлений
	 */
	async processAnnouncementSearch(): Promise<any> {
		this.logger.log('Обработка поиска объявлений...');
		
		try {
			// Параметры по умолчанию
			const defaultParams = {
				'filter[name]': '',
				'filter[customer]': '',
				'filter[number]': '',
				'filter[year]': '0',
				'filter[status][]': '220',
				'filter[method][]': '188',
				'filter[amount_from]': '10000000',
				'filter[amount_to]': '',
				'filter[trade_type]': 's',
				'filter[start_date_from]': '',
				'filter[start_date_to]': '',
				'filter[end_date_from]': '',
				'filter[end_date_to]': '',
				'filter[itog_date_from]': '',
				'filter[itog_date_to]': '',
				'smb': '',
			};
			
			// Объединяем параметры
			const params = {
				...defaultParams
			};
			
			// Отправляем GET запрос
			const response = await this.portalService.request({
				url: '/ru/search/announce',
				method: 'GET',
				params: params,
			});
			
			this.logger.log(`Поиск объявлений завершен. Успех: ${response.success}, Статус: ${response.status}`);
			
			console.log(response.data, 'response.data')
			
			if (!response.success || !response.data) {
				return {
					...response,
					processed: true,
					announcements: [],
				};
			}
			
			// Парсим HTML и извлекаем данные из таблицы
			const html = response.data as string;
			const announcements = this.htmlParserService.parseAnnouncementsTable(html);
			
			console.log('announcements', JSON.stringify(announcements))
			if (!announcements.length) {
				this.logger.warn('Объявления не найдены');
				return null;
			}
			
			// Безопасное извлечение ID объявления
			if (!announcements[0] || !announcements[0].link) {
				this.logger.warn('Не удалось извлечь номер объявления из результатов');
				return null;
			}
			
			const announcementId = announcements[0].number.split('-')[0];
			
			// Проверяем, что это строка
			if (typeof announcementId !== 'string') {
				this.logger.error(`Неверный тип announcementId: ${typeof announcementId}, значение: ${JSON.stringify(announcementId)}`);
				return null;
			}
			
			this.logger.log(`Найдено объявлений: ${announcements.length}, ID первого: ${announcementId}`);
			
			return announcementId;
			
		} catch (error) {
			this.logger.error(`Ошибка при поиске объявлений: ${(error as Error).message}`);
			throw error;
		}
	}
	
	
	/**
	 * Получить номер лота из документа
	 * @param announceId - ID объявления
	 * @param applicationId - ID заявки
	 * @param docId - ID документа (по умолчанию 1356)
	 * @returns Номер лота (№ ПП) или null
	 */
	async getLotNUmber(announceId: string, applicationId: string, docId: string = '1356'): Promise<string | null> {
		const taskId = `getLotNumber-${announceId}-${applicationId}-${docId}`;
		this.logger.log(`[${taskId}] Получение номера лота из документа ${docId}`);
		
		try {
			// Отправляем GET запрос на страницу документа с повторными попытками
			const docUrl = `/ru/application/show_doc/${announceId}/${applicationId}/${docId}`;
			const response = await this.retryRequest(
				async () => {
					const resp = await this.portalService.request({
						url: docUrl,
						method: 'GET',
						additionalHeaders: {
							'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
							'Referer': `https://v3bl.goszakup.gov.kz/ru/application/show/${announceId}/${applicationId}`,
						},
					});
					
					if (!resp.success || !resp.data || typeof resp.data !== 'string') {
						throw new Error('Не удалось получить HTML страницы документа');
					}
					
					return resp;
				},
				taskId,
				3,
				1000
			);
			
			const html = response.data as string;
			
			
			// Извлекаем номер лота из HTML
			const lotNumber = this.htmlParserService.extractLotNumber(html);
			
			
			if (lotNumber) {
				this.logger.log(`[${taskId}] Номер лота успешно извлечен: ${lotNumber}`);
				return lotNumber;
			} else {
				this.logger.warn(`[${taskId}] Не удалось извлечь номер лота из HTML`);
				return null;
			}
		} catch (error) {
			this.logger.error(`[${taskId}] Ошибка получения номера лота: ${(error as Error).message}`);
			throw error;
		}
	}
	
	
	/**
	 * Создание заявки
	 * @param announceId - ID объявления
	 * @param data - Данные для создания заявки
	 */
	async processAnnouncementCreate(announceId: string | any): Promise<any> {
		
		try {
			// Параметры по умолчанию
			const defaultParams = {
				subject_address: '789512',
				iik: '1545731',
				contact_phone: '712036',
				tax_payer_type: 'UL',
			};
			
			// Объединяем параметры
			const requestData = {
				...defaultParams,
			};
			
			// Используем метод из PortalService для отправки запроса
			
			
			const response = await this.portalService.request({
				url: `/ru/application/ajax_create_application/${announceId}`,
				method: 'POST',
				isFormData: false, // Используем x-www-form-urlencoded
				data: requestData,
				additionalHeaders: {
					'Accept': 'application/json, text/javascript, */*; q=0.01',
					'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
					'Referer': `https://v3bl.goszakup.gov.kz/ru/application/create/${announceId}`,
					'X-Requested-With': 'XMLHttpRequest',
				}
			});
			
			// Проверяем, не является ли ответ страницей авторизации
			let responseData = response.data;
			if (response.data && typeof response.data === 'string' &&
				(response.data.includes('<title>Авторизация</title>') ||
					response.data.includes('/user/login') ||
					response.redirectedToAuth)) {
				this.logger.warn(`Получена страница авторизации после POST запроса. Выполняем переавторизацию...`);
				await this.authService.login(true);
				
				// Повторяем POST запрос после авторизации
				const retryResponse = await this.portalService.request({
					url: `/ru/application/ajax_create_application/${announceId}`,
					method: 'POST',
					isFormData: false,
					data: requestData,
					additionalHeaders: {
						'Accept': 'application/json, text/javascript, */*; q=0.01',
						'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
						'Referer': `https://v3bl.goszakup.gov.kz/ru/application/create/${announceId}`,
						'X-Requested-With': 'XMLHttpRequest',
					}
				});
				
				if (retryResponse.data && typeof retryResponse.data === 'string' &&
					(retryResponse.data.includes('<title>Авторизация</title>') ||
						retryResponse.data.includes('/user/login') ||
						retryResponse.redirectedToAuth)) {
					throw new Error('После переавторизации все еще получаем страницу авторизации');
				}
				
				responseData = retryResponse.data;
			}
			
			this.logger.log(JSON.stringify(response),
				'response')
			
			
			const responseGetId = await this.portalService.request({
				url: `/ru/application/ajax_create_application/${announceId}`,
				method: 'GET',
				// Для GET запроса данные обычно не нужны или передаются в params
				// Если это просто получение страницы после создания, то параметры могут быть не нужны
			});
			
			// Проверяем, не является ли ответ страницей авторизации
			let responseGetIdData = responseGetId.data;
			if (responseGetId.data && typeof responseGetId.data === 'string' &&
				(responseGetId.data.includes('<title>Авторизация</title>') ||
					responseGetId.data.includes('/user/login') ||
					responseGetId.redirectedToAuth)) {
				this.logger.warn(`Получена страница авторизации после GET запроса. Выполняем переавторизацию...`);
				await this.authService.login(true);
				
				// Повторяем GET запрос после авторизации
				const retryGetResponse = await this.portalService.request({
					url: `/ru/application/ajax_create_application/${announceId}`,
					method: 'GET',
				});
				
				if (retryGetResponse.data && typeof retryGetResponse.data === 'string' &&
					(retryGetResponse.data.includes('<title>Авторизация</title>') ||
						retryGetResponse.data.includes('/user/login') ||
						retryGetResponse.redirectedToAuth)) {
					throw new Error('После переавторизации все еще получаем страницу авторизации');
				}
				
				responseGetIdData = retryGetResponse.data;
			}
			
			
			this.logger.log(JSON.stringify(responseGetId),
				'responseGetId')
			
			// Извлекаем ID созданной заявки из HTML
			let applicationId = null;
			if (responseGetIdData && typeof responseGetIdData === 'string') {
				applicationId = this.htmlParserService.extractCreatedApplicationId(responseGetIdData);
				if (applicationId) {
					this.logger.log(`✅ Найдена созданная заявка ID: ${applicationId}`);
					
					// Извлекаем ID лотов
					const lotIds = this.htmlParserService.extractLotIds(responseGetIdData);
					if (lotIds.length > 0) {
						this.logger.log(`Найдено лотов: ${lotIds.length}. Добавляем их в заявку...`);
						
						// Отправляем запрос на добавление лотов
						const responseAddLots = await this.portalService.request({
							url: `/ru/application/ajax_add_lots/${announceId}/${applicationId}`,
							method: 'POST',
							isFormData: false, // x-www-form-urlencoded
							data: {
								'selectLots[]': lotIds
							},
							additionalHeaders: {
								'X-Requested-With': 'XMLHttpRequest',
								'Referer': `https://v3bl.goszakup.gov.kz/ru/application/lots/${announceId}/${applicationId}`
							}
						});
						
						this.logger.log(`Результат добавления лотов: ${JSON.stringify(responseAddLots.data)}`);
						
						
						if (responseAddLots.success) {
							// Если лоты добавлены успешно, переходим к следующему шагу
							this.logger.log('Переход к следующему шагу (ajax_lots_next)...');
							const responseNext = await this.portalService.request({
								url: `/ru/application/ajax_lots_next/${announceId}/${applicationId}`,
								method: 'POST',
								isFormData: false,
								data: {
									next: 1,
									confirmed: 0
								},
								additionalHeaders: {
									'X-Requested-With': 'XMLHttpRequest',
									'Referer': `https://v3bl.goszakup.gov.kz/ru/application/lots/${announceId}/${applicationId}`
								}
							});
							
							this.logger.log(`Результат перехода к следующему шагу: ${JSON.stringify(responseNext.data)}`);
						}
					} else {
						this.logger.warn('⚠️  Лоты не найдены на странице выбора лотов');
					}
				} else {
					this.logger.warn('⚠️  Не удалось извлечь ID заявки из HTML ответа');
				}
			}
			
			return {
				...response,
				processed: true,
				applicationId: applicationId
			};
		} catch (error) {
			this.logger.error(`Ошибка при создании заявки: ${(error as Error).message}`);
			throw error;
		}
	}
	
	
	async appendixHandle(announceId: string, applicationId: string, docId: string): Promise<any> {
		await this.appendixService.firstAppendixHandle(announceId, applicationId, docId)
		
	}
	
	async appendixSecondHandle(announceId: string, applicationId: string, docId: string): Promise<any> {
		this.logger.log(`Обработка второго приложения для документа ${docId} заявки ${applicationId}...`);
		
		const taskId = `appendixSecondHandle-${docId}`;
		const docUrl = `/ru/application/show_doc/${announceId}/${applicationId}/${docId}`;
		
		try {
			// Шаг 1: Отправить GET запрос для получения HTML с data-url и fileIdentifier
			this.logger.log(`[${taskId}] Отправка GET запроса на ${docUrl}...`);
			
			const getResponse = await this.portalService.request({
				url: docUrl,
				method: 'GET',
				additionalHeaders: {
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'Referer': `https://v3bl.goszakup.gov.kz/ru/application/show/${announceId}/${applicationId}`,
				}
			});
			
			if (!getResponse.success || !getResponse.data || typeof getResponse.data !== 'string') {
				throw new Error('Не удалось получить HTML ответ от сервера');
			}
			
			let html = getResponse.data as string;
			
			// Проверяем, не является ли это страницей авторизации используя cheerio
			let isAuthPage = false;
			try {
				const $ = cheerio.load(html);
				const title = $('title').text().trim();
				isAuthPage = title.includes('Авторизация') || html.includes('/user/auth') || getResponse.redirectedToAuth;
			} catch (error) {
				isAuthPage = html.includes('<title>Авторизация</title>') || html.includes('/user/auth') || getResponse.redirectedToAuth;
			}
			
			if (isAuthPage) {
				this.logger.warn(`[${taskId}] Получена страница авторизации, сессия истекла. Выполняем переавторизацию...`);
				
				// Выполняем переавторизацию
				await this.authService.login(true);
				
				// Повторяем запрос после авторизации
				this.logger.log(`[${taskId}] Повторный запрос после авторизации...`);
				const retryResponse = await this.portalService.request({
					url: docUrl,
					method: 'GET',
					additionalHeaders: {
						'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
						'Referer': `https://v3bl.goszakup.gov.kz/ru/application/show/${announceId}/${applicationId}`,
					}
				});
				
				if (!retryResponse.success || !retryResponse.data || typeof retryResponse.data !== 'string') {
					throw new Error('Не удалось получить HTML после переавторизации');
				}
				
				html = retryResponse.data as string;
				
				// Проверяем еще раз используя cheerio
				let isAuthPageRetry = false;
				try {
					const $ = cheerio.load(html);
					const pageTitle = $('title').text().trim();
					isAuthPageRetry = pageTitle.includes('Авторизация') || html.includes('/user/auth') || retryResponse.redirectedToAuth;
				} catch (error) {
					isAuthPageRetry = html.includes('<title>Авторизация</title>') || html.includes('/user/auth') || retryResponse.redirectedToAuth;
				}
				
				if (isAuthPageRetry) {
					throw new Error('После переавторизации все еще получаем страницу авторизации');
				}
			}
			
			// Шаг 2: Извлечь data-url и fileIdentifier из блока add_signature_block
			const signatureData = this.htmlParserService.extractSignatureButtonData(html);
			
			if (!signatureData.dataUrl || !signatureData.fileIdentifier) {
				// Проверяем, может быть файл уже подписан используя cheerio
				let hasGreenCheck = false;
				try {
					const $ = cheerio.load(html);
					hasGreenCheck = $('.glyphicon-check').length > 0 &&
						($('.glyphicon-check').css('color') === 'green' ||
							$('.glyphicon-check').parent().css('color') === 'green' ||
							html.includes('color: green'));
				} catch (error) {
					hasGreenCheck = html.includes('glyphicon-check') && html.includes('color: green');
				}
				
				if (hasGreenCheck) {
					this.logger.log(`[${taskId}] Файл уже подписан (есть зеленая галочка). Пропускаем обработку.`);
					return {
						success: true,
						status: 200,
						alreadySigned: true,
						message: 'Файл уже подписан',
					};
				}
				
				// Расширенная диагностика используя cheerio
				this.logger.error(`[${taskId}] Не удалось извлечь data-url или fileIdentifier из HTML`);
				
				try {
					const $ = cheerio.load(html);
					
					// Проверяем наличие ключевых элементов
					const hasAddSignatureBlock = $('.add_signature_block').length > 0;
					const hasBtnAddSignature = $('.btn-add-signature').length > 0;
					const hasDataUrl = $('[data-url]').length > 0;
					const hasDataFileIdentifier = $('[data-file-identifier]').length > 0;
					const hasDownloadFile = $('a[href*="download_file"]').length > 0;
					const hasTable = $('table').length > 0 || $('tbody').length > 0;
					
					this.logger.error(`[${taskId}] Диагностика: hasAddSignatureBlock=${hasAddSignatureBlock}, hasBtnAddSignature=${hasBtnAddSignature}, hasDataUrl=${hasDataUrl}, hasDataFileIdentifier=${hasDataFileIdentifier}, hasDownloadFile=${hasDownloadFile}, hasTable=${hasTable}`);
					
					// Пробуем найти блоки с подписями для отладки
					const signatureBlocks = $('.add_signature_block');
					if (signatureBlocks.length > 0) {
						this.logger.debug(`[${taskId}] Найдено блоков с add_signature: ${signatureBlocks.length}`);
						signatureBlocks.slice(0, 2).each((idx, elem) => {
							this.logger.debug(`[${taskId}] Блок ${idx + 1}: ${$(elem).html()?.substring(0, 500)}`);
						});
					}
					
					// Пробуем найти кнопки с data-url для отладки
					const buttonsWithDataUrl = $('button[data-url]');
					if (buttonsWithDataUrl.length > 0) {
						this.logger.debug(`[${taskId}] Найдено кнопок с data-url: ${buttonsWithDataUrl.length}`);
						buttonsWithDataUrl.slice(0, 2).each((idx, elem) => {
							this.logger.debug(`[${taskId}] Кнопка ${idx + 1}: ${$(elem).toString().substring(0, 500)}`);
						});
					}
					
					// Пробуем найти ссылки на файлы
					const downloadLinks = $('a[href*="download_file"]');
					if (downloadLinks.length > 0) {
						this.logger.debug(`[${taskId}] Найдено ссылок на download_file: ${downloadLinks.length}`);
						downloadLinks.slice(0, 3).each((idx, elem) => {
							this.logger.debug(`[${taskId}] Ссылка ${idx + 1}: ${$(elem).toString().substring(0, 500)}`);
						});
					}
				} catch (error) {
					this.logger.error(`[${taskId}] Ошибка при диагностике через cheerio: ${(error as Error).message}`);
					// Fallback на старый метод
					const hasAddSignatureBlock = html.includes('add_signature_block');
					const hasBtnAddSignature = html.includes('btn-add-signature');
					const hasDataUrl = html.includes('data-url');
					const hasDataFileIdentifier = html.includes('data-file-identifier');
					const hasDownloadFile = html.includes('download_file');
					const hasTable = html.includes('<table') || html.includes('<tbody>');
					this.logger.error(`[${taskId}] Диагностика (fallback): hasAddSignatureBlock=${hasAddSignatureBlock}, hasBtnAddSignature=${hasBtnAddSignature}, hasDataUrl=${hasDataUrl}, hasDataFileIdentifier=${hasDataFileIdentifier}, hasDownloadFile=${hasDownloadFile}, hasTable=${hasTable}`);
				}
				
				throw new Error(`Не удалось извлечь data-url или fileIdentifier из HTML. dataUrl: ${signatureData.dataUrl}, fileIdentifier: ${signatureData.fileIdentifier}`);
			}
			
			this.logger.log(`[${taskId}] Извлечены данные: dataUrl=${signatureData.dataUrl}, fileIdentifier=${signatureData.fileIdentifier}`);
			
			// Шаг 3: Скачать файл
			this.logger.log(`[${taskId}] Скачивание файла ${signatureData.dataUrl}...`);
			const { fileBuffer, ext } = await this.appendixService.downloadFile(signatureData.dataUrl, taskId);
			this.logger.log(`[${taskId}] Файл скачан в память (${fileBuffer.length} байт)`);
			
			// Шаг 4: Подписать файл
			this.logger.log(`[${taskId}] Подписание файла...`);
			const signedDocument = await this.appendixService.signFile(fileBuffer, ext, taskId, signatureData.dataUrl);
			this.logger.log(`[${taskId}] Файл подписан`);
			
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
			
			this.logger.log(`[${taskId}] Подпись извлечена, длина: ${signature.length}`);
			
			// Шаг 6: Отправить POST запрос с подписанными данными
			this.logger.log(`[${taskId}] Отправка POST запроса с подписью...`);
			
			const formData: Record<string, any> = {
				[`userfile[${docId}]`]: signatureData.fileIdentifier,
				'save_form': '',
				[`signature[${signatureData.fileIdentifier}]`]: signature,
			};
			
			const postResponse = await this.portalService.request({
				url: docUrl,
				method: 'POST',
				isFormData: true,
				data: formData,
				additionalHeaders: {
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'Referer': `https://v3bl.goszakup.gov.kz${docUrl}`,
				}
			});
			
			this.logger.log(`[${taskId}] POST запрос отправлен. Статус: ${postResponse.status}`);
			
			return {
				success: postResponse.success,
				status: postResponse.status,
				fileIdentifier: signatureData.fileIdentifier,
				dataUrl: signatureData.dataUrl,
				response: postResponse.data,
			};
		} catch (error) {
			this.logger.error(`[${taskId}] Ошибка обработки второго приложения: ${(error as Error).message}`);
			throw error;
		}
	}
	
	
	async setupBeneficialOwnershipInformation(announceId: string, applicationId: string, docId: string, extractedAppLotId: string): Promise<any> {
		this.logger.log(`Обработка сохранения информации о бенефициарном владельце для заявки ${applicationId}...`);
		
		const taskId = `setupBeneficialOwnershipInformation-${announceId}-${applicationId}-${docId}`;
		
		try {
			// Шаг 1: Получить HTML страницы для извлечения appLotId из ссылки "Заполнить"
			const docUrl = `/ru/application/show_doc/${announceId}/${applicationId}/${docId}`;
			this.logger.log(`[${taskId}] Отправка GET запроса на ${docUrl} для извлечения appLotId...`);
			
			const getResponse = await this.portalService.request({
				url: docUrl,
				method: 'GET',
				additionalHeaders: {
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'Referer': `https://v3bl.goszakup.gov.kz/ru/application/show/${announceId}/${applicationId}`,
				}
			});
			
			
			// Параметры по умолчанию
			const defaultData = {
				beneficiary_name: 'САГИМБАЕВ БАУЫРЖАН ТЛЕУИЕВИЧ',
				citizenship: '398',
				res_country: '398',
				beneficiary_doc_number: '042380208',
				beneficiary_doc_date: '2017-02-23',
				option_1: '1',
				option_2: '1',
				option_3: '1',
				option_4: '2',
				app_lot_id: extractedAppLotId,
				beneficiary_id: '',
			};
			
			// Объединяем параметры по умолчанию с переданными данными
			const requestData = {
				...defaultData,
			};
			
			// Отправляем POST запрос с form data
			const response = await this.portalService.request({
				url: '/ru/beneficiary/ajax_save_info',
				method: 'POST',
				isFormData: true,
				data: requestData,
				additionalHeaders: {
					'Accept': 'application/json, text/javascript, */*; q=0.01',
					'Referer': `https://v3bl.goszakup.gov.kz/ru/application/show/${announceId}/${applicationId}`,
					'X-Requested-With': 'XMLHttpRequest',
				}
			});
			
			// await this.portalService.request({
			// 	url: '/ru/beneficiary/ajax_save_info',
			// 	method: 'POST',
			// 	isFormData: true,
			// 	data: requestData,
			// 	additionalHeaders: {
			// 		'Accept': 'application/json, text/javascript, */*; q=0.01',
			// 		'Referer': `https://v3bl.goszakup.gov.kz/ru/application/show/${announceId}/${applicationId}`,
			// 		'X-Requested-With': 'XMLHttpRequest',
			// 	}
			// });
			
			this.logger.log(`[${taskId}] Сохранение информации о бенефициарном владельце завершено. Успех: ${response.success}, Статус: ${response.status}`);
			
			if (!extractedAppLotId) {
				throw new Error('Не удалось извлечь appLotId из ссылки "Заполнить"');
			}
			
			// Шаг 2: Отправить POST запрос для генерации формы подписания
			const formDocUrl = `/ru/application/show_doc/${announceId}/${applicationId}/${docId}`;
			this.logger.log(`[${taskId}] Отправка POST запроса на ${formDocUrl} для генерации формы подписания...`);
			
			const generateFormData = {
				generate: '',
				[`userfile[${docId}]`]: '',
				save_form: '',
			};
			
			const generateResponse = await this.portalService.request({
				url: formDocUrl,
				method: 'POST',
				isFormData: true,
				data: generateFormData,
				additionalHeaders: {
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'Referer': `https://v3bl.goszakup.gov.kz/ru/application/show/${announceId}/${applicationId}`,
				}
			});
			
			if (!generateResponse.success || !generateResponse.data || typeof generateResponse.data !== 'string') {
				throw new Error('Не удалось получить HTML ответ после генерации формы');
			}
			
			const formHtml = generateResponse.data as string;
			
			// Шаг 3: Извлечь data-url и fileIdentifier из кнопки подписи используя cheerio
			let fileDataUrl: string | null = null;
			let fileIdentifier: string | null = null;
			
			try {
				const $ = cheerio.load(formHtml);
				
				// Ищем кнопку с классом btn-add-signature
				const $button = $('button.btn-add-signature[data-url][data-file-identifier]').first();
				
				if ($button.length > 0) {
					fileDataUrl = $button.attr('data-url')?.trim() || null;
					fileIdentifier = $button.attr('data-file-identifier')?.trim() || null;
					
					if (fileDataUrl && fileIdentifier) {
						this.logger.log(`[${taskId}] Найдена кнопка подписи: dataUrl="${fileDataUrl}", fileIdentifier="${fileIdentifier}"`);
					}
				}
				
				// Если не нашли, пробуем в блоках add_signature_block
				if (!fileDataUrl || !fileIdentifier) {
					$('.add_signature_block button[data-url][data-file-identifier]').first().each((i, elem) => {
						const $btn = $(elem);
						fileDataUrl = $btn.attr('data-url')?.trim() || null;
						fileIdentifier = $btn.attr('data-file-identifier')?.trim() || null;
						if (fileDataUrl && fileIdentifier) {
							this.logger.log(`[${taskId}] Найдена кнопка в блоке: dataUrl="${fileDataUrl}", fileIdentifier="${fileIdentifier}"`);
						}
					});
				}
			} catch (error) {
				this.logger.error(`[${taskId}] Ошибка при извлечении данных кнопки через cheerio: ${(error as Error).message}`);
			}
			
			if (!fileDataUrl || !fileIdentifier) {
				throw new Error(`Не удалось извлечь data-url или fileIdentifier из HTML. dataUrl: ${fileDataUrl}, fileIdentifier: ${fileIdentifier}`);
			}
			
			// Шаг 4: Скачать файл
			this.logger.log(`[${taskId}] Скачивание файла ${fileDataUrl}...`);
			const { fileBuffer, ext } = await this.appendixService.downloadFile(fileDataUrl, taskId);
			this.logger.log(`[${taskId}] Файл скачан в память (${fileBuffer.length} байт)`);
			
			// Шаг 5: Подписать файл
			this.logger.log(`[${taskId}] Подписание файла...`);
			const signedDocument = await this.appendixService.signFile(fileBuffer, ext, taskId, fileDataUrl);
			this.logger.log(`[${taskId}] Файл подписан`);
			
			// Шаг 6: Извлечь подпись из подписанного файла
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
			
			this.logger.log(`[${taskId}] Подпись извлечена, длина: ${signature.length}`);
			
			// Шаг 7: Отправить POST запрос с подписью
			this.logger.log(`[${taskId}] Отправка POST запроса с подписью...`);
			
			const signFormData = {
				[`userfile[${docId}]`]: fileIdentifier,
				save_form: '',
				[`signature[${fileIdentifier}]`]: signature,
			};
			
			const signResponse = await this.portalService.request({
				url: formDocUrl,
				method: 'POST',
				isFormData: true,
				data: signFormData,
				additionalHeaders: {
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'Referer': `https://v3bl.goszakup.gov.kz${formDocUrl}`,
				}
			});
			
			this.logger.log(`[${taskId}] POST запрос с подписью отправлен. Статус: ${signResponse.status} ${JSON.stringify(signResponse)}`);
			
			return {
				...response,
				processed: true,
				fileIdentifier,
				signResponse: {
					success: signResponse.success,
					status: signResponse.status,
				},
			};
		} catch (error) {
			this.logger.error(`Ошибка при сохранении информации о бенефициарном владельце: ${(error as Error).message}`);
			throw error;
		}
	}
	
	
	async copyingQualificationInformation(announceId: string, applicationId: string, docId: string, annoNumber?: string): Promise<any> {
		this.logger.log(`Копирование квалификационной информации для документа ${docId} заявки ${applicationId}...`);
		
		try {
			// Параметры по умолчанию
			const defaultAnnoNumber = annoNumber || '15880798-1';
			
			// Шаг 1: Отправить запрос на поиск
			this.logger.log(`[${docId}] Отправка запроса на поиск квалификационной информации...`);
			const searchUrl = `/ru/application/copy_data_docs/${announceId}/${applicationId}/${docId}`;
			
			const searchResponse = await this.portalService.request({
				url: searchUrl,
				method: 'POST',
				isFormData: true,
				data: {
					anno_number: defaultAnnoNumber,
					search: 'Найти',
				},
				additionalHeaders: {
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'Referer': `https://v3bl.goszakup.gov.kz${searchUrl}`,
				}
			});
			
			this.logger.log(`[${docId}] Запрос на поиск отправлен. Статус: ${searchResponse.status}`);
			
			if (!searchResponse.success || !searchResponse.data || typeof searchResponse.data !== 'string') {
				throw new Error('Не удалось получить HTML ответ от сервера');
			}
			
			// Шаг 2: Извлечь from_lot и to_lot из HTML
			const html = searchResponse.data as string;
			const fromLot = this.htmlParserService.extractFromLot(html);
			const toLot = this.htmlParserService.extractToLot(html);
			
			if (!fromLot) {
				throw new Error('Не удалось извлечь from_lot из HTML ответа');
			}
			
			if (!toLot) {
				throw new Error('Не удалось извлечь to_lot из HTML ответа');
			}
			
			this.logger.log(`[${docId}] Извлечены значения: from_lot=${fromLot}, to_lot=${toLot}`);
			
			// Шаг 3: Отправить запрос на применение
			this.logger.log(`[${docId}] Отправка запроса на применение квалификационной информации...`);
			
			const applyResponse = await this.portalService.request({
				url: searchUrl,
				method: 'POST',
				isFormData: true,
				data: {
					from_lot: fromLot,
					'to_lot[]': toLot,
					anno_number: defaultAnnoNumber,
					submit: 'Применить',
				},
				additionalHeaders: {
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'Referer': `https://v3bl.goszakup.gov.kz${searchUrl}`,
				}
			});
			
			this.logger.log(`[${docId}] Запрос на применение отправлен. Статус: ${applyResponse.status}`);
			
			// Шаг 4: Обработать документ (сформировать, подписать и отправить)
			this.logger.log(`[${docId}] Обработка документа после копирования квалификационной информации...`);
			const docResult = await this.appendixService.handleDocumentWithBankruptcy(announceId, applicationId, docId, '2');
			
			return {
				success: applyResponse.success,
				status: applyResponse.status,
				fromLot,
				toLot,
				annoNumber: defaultAnnoNumber,
				applyResponse: applyResponse.data,
				documentResult: docResult,
			};
		} catch (error) {
			this.logger.error(`Ошибка при копировании квалификационной информации: ${(error as Error).message}`);
			throw error;
		}
	}
	
	//https://v3bl.goszakup.gov.kz/ru/application/show_doc/15812917/68062359/3353/79935875/1/?show=3
	async addingBidSecurity(announceId: string, applicationId: string, docId: string, taskId: string): Promise<any> {
		this.logger.log(`Добавление обеспечения заявки для документа ${docId} заявки ${applicationId}...`);
		
		try {
			// Шаг 1: Отправить GET запрос для получения HTML с ссылкой "Добавить"
			const initialUrl = `/ru/application/show_doc/${announceId}/${applicationId}/${docId}/${taskId}/1`;
			this.logger.log(`[${docId}] Отправка GET запроса для получения ссылки "Добавить"...`);
			
	
			const urlWithQuery = `${initialUrl}?show=3`;
			this.logger.log(`[${docId}] Сформирован URL для POST запроса: ${urlWithQuery}`);
			
			// Шаг 4: Отправить POST запрос с form data
			this.logger.log(`[${docId}] Отправка POST запроса на сохранение электронных данных...`);
			
			const response = await this.portalService.request({
				url: urlWithQuery,
				method: 'POST',
				isFormData: true,
				data: {
					typeDoc: '3',
					save_electronic_data: 'Сохранить',
				},
				additionalHeaders: {
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'Referer': `https://v3bl.goszakup.gov.kz${initialUrl}`,
				}
			});
			
			this.logger.log(`[${docId}] Запрос на сохранение электронных данных отправлен. Статус: ${response.status}`);
			
			return {
				success: response.success,
				status: response.status,
				docUrl: initialUrl,
				response: response.data,
			};
		} catch (error) {
			this.logger.error(`Ошибка при добавлении обеспечения заявки: ${(error as Error).message}`);
			throw error;
		}
	}
	
	
	async obtainPermits(announceId: string, applicationId: string, docId: string, requestText?: string): Promise<any> {
		this.logger.log(`Получение разрешений для документа ${docId} заявки ${applicationId}...`);
		
		try {
			// Параметры по умолчанию
			const defaultRequestText = requestText || 'KZ35VWC00252553';
			
			// Шаг 1: Отправить POST запрос на получение разрешений
			const permitsUrl = `/ru/cabinet/permits/${announceId}/${applicationId}/${docId}`;
			this.logger.log(`[${docId}] Отправка запроса на получение разрешений...`);
			
			const permitsResponse = await this.portalService.request({
				url: permitsUrl,
				method: 'POST',
				isFormData: true,
				data: {
					'filter[nikad]': '',
					'filter[date_issue]': '',
					'request[type]': '1',
					'request[text]': defaultRequestText,
					'request[date_issue]': '',
					'get_permit': 'Получить разрешения',
					'type': 'permit',
				},
				additionalHeaders: {
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'Referer': `https://v3bl.goszakup.gov.kz${permitsUrl}`,
				}
			});
			
			this.logger.log(`[${docId}] Запрос на получение разрешений отправлен. Статус: ${permitsResponse.status}`);
			
			// Шаг 2: Отправить GET запрос на show_doc для получения HTML с таблицей
			const docUrl = `/ru/application/show_doc/${announceId}/${applicationId}/${docId}`;
			this.logger.log(`[${docId}] Отправка GET запроса для получения таблицы разрешений...`);
			
			const docResponse = await this.portalService.request({
				url: docUrl,
				method: 'GET',
				additionalHeaders: {
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'Referer': `https://v3bl.goszakup.gov.kz/ru/application/show/${announceId}/${applicationId}`,
				}
			});
			
			this.logger.log(`[${docId}] GET запрос выполнен. Статус: ${docResponse.status}`);
			
			if (!docResponse.success || !docResponse.data || typeof docResponse.data !== 'string') {
				throw new Error('Не удалось получить HTML ответ от сервера');
			}
			
			let html = docResponse.data as string;
			
			// Проверяем авторизацию и переавторизуемся при необходимости
			const reauthHtml = await this.checkAndReauthIfNeeded(
				html,
				docResponse,
				`obtainPermits-${docId}`,
				docUrl,
				{
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'Referer': `https://v3bl.goszakup.gov.kz/ru/application/show/${announceId}/${applicationId}`,
				}
			);
			if (reauthHtml) {
				html = reauthHtml;
			}
			
			// Шаг 3: Извлечь value из первого checkbox permit_select[]
			// Логируем фрагмент HTML для отладки (первые 5000 символов)
			const htmlPreview = html.substring(0, 5000);
			this.logger.debug(`[${docId}] HTML превью (первые 5000 символов): ${htmlPreview}`);
			
			const permitValue = this.htmlParserService.extractFirstPermitSelectValue(html);
			
			if (!permitValue) {
				// Логируем больше информации для отладки
				const hasPermitSelect = html.includes('permit_select');
				const hasCheckbox = html.includes('type="checkbox"') || html.includes("type='checkbox'");
				const hasTable = html.includes('<tbody>') || html.includes('<table');
				
				this.logger.error(`[${docId}] Не удалось извлечь value из permit_select[] из HTML ответа`);
				this.logger.error(`[${docId}] Диагностика: hasPermitSelect=${hasPermitSelect}, hasCheckbox=${hasCheckbox}, hasTable=${hasTable}`);
				
				// Пробуем найти любые checkbox в HTML для отладки
				const allCheckboxes = html.match(/<input[^>]*type=["']checkbox["'][^>]*>/gi);
				if (allCheckboxes) {
					this.logger.debug(`[${docId}] Найдено checkbox в HTML: ${allCheckboxes.length}`);
					allCheckboxes.slice(0, 3).forEach((cb, idx) => {
						this.logger.debug(`[${docId}] Checkbox ${idx + 1}: ${cb.substring(0, 200)}`);
					});
				}
				
				throw new Error('Не удалось извлечь value из permit_select[] из HTML ответа');
			}
			
			this.logger.log(`[${docId}] Извлечен value: ${permitValue}`);
			
			// Шаг 4: Отправить POST запрос с выбранным разрешением
			this.logger.log(`[${docId}] Отправка POST запроса с выбранным разрешением...`);
			
			const selectResponse = await this.portalService.request({
				url: docUrl,
				method: 'POST',
				isFormData: true,
				data: {
					'permit_select[]': permitValue,
					'btn_select': '',
				},
				additionalHeaders: {
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'Referer': `https://v3bl.goszakup.gov.kz${docUrl}`,
				}
			});
			
			this.logger.log(`[${docId}] Запрос с выбранным разрешением отправлен. Статус: ${selectResponse.status}`);
			
			return {
				success: selectResponse.success,
				status: selectResponse.status,
				permitValue: permitValue,
				response: selectResponse.data,
			};
		} catch (error) {
			this.logger.error(`Ошибка при получении разрешений: ${(error as Error).message}`);
			throw error;
		}
	}
	
	
	//3357
	//https://v3bl.goszakup.gov.kz/ru/application/show_doc/15812917/68064695/3357/79938927/1
	async dataSheet(announceId: string, applicationId: string, docId: string): Promise<any> {
		this.logger.log(`Обработка листа данных для документа ${docId} заявки ${applicationId}...`);
		
		const taskId = `dataSheet-${docId}`;
		
		try {
			// Шаг 1: Отправить GET запрос на show_doc для получения всех ссылок
			const initialDocUrl = `/ru/application/show_doc/${announceId}/${applicationId}/${docId}`;
			this.logger.log(`[${taskId}] Отправка GET запроса для получения ссылок...`);
			
			const initialResponse = await this.portalService.request({
				url: initialDocUrl,
				method: 'GET',
				additionalHeaders: {
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'Referer': `https://v3bl.goszakup.gov.kz/ru/application/show/${announceId}/${applicationId}`,
				}
			});
			
			if (!initialResponse.success || !initialResponse.data || typeof initialResponse.data !== 'string') {
				throw new Error('Не удалось получить HTML ответ от сервера для извлечения ссылок');
			}
			
			let initialHtml = initialResponse.data as string;
			
			// Проверяем авторизацию и переавторизуемся при необходимости
			const reauthHtml = await this.checkAndReauthIfNeeded(
				initialHtml,
				initialResponse,
				taskId,
				initialDocUrl,
				{
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'Referer': `https://v3bl.goszakup.gov.kz/ru/application/show/${announceId}/${applicationId}`,
				}
			);
			if (reauthHtml) {
				initialHtml = reauthHtml;
			}
			const viewHrefs = this.htmlParserService.extractAllViewHrefs(initialHtml);
			
			if (viewHrefs.length === 0) {
				throw new Error('Не удалось извлечь href из ссылок "Просмотреть" или "Дополнение к тех. спец."');
			}
			
			this.logger.log(`[${taskId}] Найдено ссылок: ${viewHrefs.length}: ${viewHrefs.join(', ')}`);
			
			// Шаг 2: Для каждой ссылки получить HTML и извлечь все data-url и fileIdentifier
			const allFileData: Array<{ dataUrl: string; fileIdentifier: string; viewHref: string }> = [];
			
			for (const viewHref of viewHrefs) {
				this.logger.log(`[${taskId}] Отправка GET запроса на ${viewHref}...`);
				
				const viewResponse = await this.portalService.request({
					url: viewHref,
					method: 'GET',
					additionalHeaders: {
						'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
						'Referer': `https://v3bl.goszakup.gov.kz${initialDocUrl}`,
					}
				});
				
				if (!viewResponse.success || !viewResponse.data || typeof viewResponse.data !== 'string') {
					this.logger.warn(`[${taskId}] Не удалось получить HTML ответ для ${viewHref}`);
					continue;
				}
				
				const viewHtml = viewResponse.data as string;
				const fileDataList = this.htmlParserService.extractAllSignatureButtonData(viewHtml);
				
				for (const fileData of fileDataList) {
					allFileData.push({
						...fileData,
						viewHref,
					});
				}
			}
			
			if (allFileData.length === 0) {
				throw new Error('Не удалось извлечь data-url из HTML ответов');
			}
			
			this.logger.log(`[${taskId}] Найдено файлов для обработки: ${allFileData.length}`);
			
			// Шаг 3: Скачать и подписать все файлы
			// Группируем файлы по viewHref для последующей отправки
			const filesByViewHref: Record<string, Array<{ fileIdentifier: string; signature: string }>> = {};
			
			for (const fileData of allFileData) {
				const fileTaskId = `${taskId}-${fileData.fileIdentifier}`;
				
				try {
					this.logger.log(`[${fileTaskId}] Скачивание файла ${fileData.dataUrl}...`);
					const { fileBuffer, ext } = await this.appendixService.downloadFile(fileData.dataUrl, fileTaskId);
					this.logger.log(`[${fileTaskId}] Файл скачан в память (${fileBuffer.length} байт)`);
					
					this.logger.log(`[${fileTaskId}] Подписание файла...`);
					const signedDocument = await this.appendixService.signFile(fileBuffer, ext, fileTaskId, fileData.dataUrl);
					this.logger.log(`[${fileTaskId}] Файл подписан`);
					
					// Извлечь подпись из подписанного файла
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
					
					// Группируем по viewHref
					if (!filesByViewHref[fileData.viewHref]) {
						filesByViewHref[fileData.viewHref] = [];
					}
					filesByViewHref[fileData.viewHref].push({
						fileIdentifier: fileData.fileIdentifier,
						signature,
					});
					
					this.logger.log(`[${fileTaskId}] Подпись извлечена, длина: ${signature.length}`);
				} catch (error) {
					this.logger.error(`[${fileTaskId}] Ошибка при обработке файла: ${(error as Error).message}`);
					throw error;
				}
			}
			
			// Шаг 4: Отправить POST запрос для каждой группы файлов (по viewHref)
			const saveResponses: Array<{ viewHref: string; success: boolean; status: number }> = [];
			
			for (const viewHref in filesByViewHref) {
				const fileSignatures = filesByViewHref[viewHref];
				this.logger.log(`[${taskId}] Отправка POST запроса на ${viewHref} с ${fileSignatures.length} подписями...`);
				
				// Формируем form data с подписями для этой группы
				const formData: Record<string, any> = {
					'send': 'Сохранить',
					'sign_files': '',
				};
				
				for (const fileSig of fileSignatures) {
					formData[`signature[${fileSig.fileIdentifier}]`] = fileSig.signature;
				}
				
				const saveResponse = await this.portalService.request({
					url: viewHref,
					method: 'POST',
					isFormData: true,
					data: formData,
					additionalHeaders: {
						'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
						'Referer': `https://v3bl.goszakup.gov.kz${viewHref}`,
					}
				});
				
				saveResponses.push({
					viewHref,
					success: saveResponse.success,
					status: saveResponse.status,
				});
				
				this.logger.log(`[${taskId}] POST запрос отправлен на ${viewHref}. Статус: ${saveResponse.status}, подписей: ${fileSignatures.length}`);
			}
			
			const allSuccess = saveResponses.every(r => r.success);
			
			return {
				success: allSuccess,
				filesProcessed: allFileData.length,
				requestsSent: saveResponses.length,
				responses: saveResponses,
			};
		} catch (error) {
			this.logger.error(`[${taskId}] Ошибка при обработке листа данных: ${(error as Error).message}`);
			throw error;
		}
	}
	
	
	async setPrice(announceId: string, applicationId: string, docId: string): Promise<any> {
		const taskId = `setPrice-${announceId}-${applicationId}-${docId}`;
		this.logger.log(`[${taskId}] Старт установки цены...`);
		
		// Сразу инициируем подключение к crypto socket (TumarCSP) и NCALayer
		// Не ждем завершения - подключение будет установлено в фоне, а при необходимости повторим в sign()
		this.cryptoSocketService.connect();
		this.nclayerService.connect().catch(err => {
			this.logger.debug(`[${taskId}] Не удалось заранее подключиться к NCALayer (это нормально, подключимся позже): ${err.message}`);
		});
		
		const downloadedData: any = {};
		
		try {
			// 0. Сначала отправляем запрос на переход к следующему шагу
			this.logger.log(`[${taskId}] Отправка запроса на переход к следующему шагу...`);
			const priceoffersUrl = `/ru/application/ajax_docs_next/${announceId}/${applicationId}`;
			const priceUrl = priceoffersUrl; // Сохраняем для дальнейшего использования
			
			const priceoffersFormData: Record<string, any> = {
				'next': '1',
			};
			
			this.logger.debug(`[${taskId}] Отправка form data: next=1`);
			
			const nextStep = await this.portalService.request({
				url: priceoffersUrl,
				method: 'POST',
				data: priceoffersFormData,
				isFormData: true,
				additionalHeaders: {
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'Referer': `https://v3bl.goszakup.gov.kz/ru/application/show/${announceId}/${applicationId}`,
				}
			});
			
			
			console.log(nextStep, 'nextStep')
			const priceoffersResponse = await this.portalService.request({
				url: priceoffersUrl,
				method: 'GET',
				isFormData: true,
				additionalHeaders: {
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'Referer': `https://v3bl.goszakup.gov.kz/ru/application/show/${announceId}/${applicationId}`,
				}
			});
			
			let html: string = '';
			let priceResponse: any = priceoffersResponse;
			
			if (priceoffersResponse.success) {
				this.logger.log(`[${taskId}] Запрос на переход к следующему шагу успешно отправлен`);
				
				// Проверяем, содержит ли ответ POST запроса нужные данные
				if (priceoffersResponse.data && typeof priceoffersResponse.data === 'string') {
					const postHtml = priceoffersResponse.data;
					if (postHtml.includes('hsm_api_key') || postHtml.includes('public_key')) {
						this.logger.log(`[${taskId}] Нужные данные найдены в ответе POST запроса next=1`);
						html = postHtml;
					}
				}
			} else {
				this.logger.error(`[${taskId}] Ошибка при отправке запроса на переход к следующему шагу: ${priceoffersResponse.error || 'Unknown error'}. Статус: ${priceoffersResponse.status}`);
			}
			
			// 1. Если данные не найдены в POST ответе, получаем HTML через GET
			if (!html) {
				this.logger.log(`[${taskId}] Данные не найдены в POST ответе, выполняем GET запрос...`);
				priceResponse = await this.retryRequest(
					async () => {
						return await this.portalService.request({
							url: priceUrl,
							method: 'GET',
							additionalHeaders: {
								'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
								'Referer': `https://v3bl.goszakup.gov.kz/ru/application/show/${announceId}/${applicationId}`,
							},
						});
					},
					taskId,
					3,
					1000
				);
				
				if (!priceResponse.success || !priceResponse.data || typeof priceResponse.data !== 'string') {
					this.logger.error(`[${taskId}] Не удалось получить корректный HTML для ценовых предложений. Success: ${priceResponse.success}, Status: ${priceResponse.status}, Data type: ${typeof priceResponse.data}`);
					if (priceResponse.data) {
						this.logger.error(`[${taskId}] Содержимое ответа: ${JSON.stringify(priceResponse.data).substring(0, 2000)}`);
					}
					throw new Error('Не удалось получить HTML для ценовых предложений');
				}
				
				html = priceResponse.data as string;
			}
			
			
			console.log(html, 'html===>')
			// Логируем заголовки для диагностики редиректов
			if (priceResponse.headers) {
				if (priceResponse.headers.location) {
					this.logger.debug(`[${taskId}] Redirect Location: ${priceResponse.headers.location}`);
				}
			}
			
			// Проверка содержимого (есть ли вообще искомые строки)
			const hasHsmKeyString = html.includes('hsm_api_key');
			const hasPublicKeyString = html.includes('public_key');
			const hasEncrString = html.includes('getDataAndEncr');
			this.logger.debug(`[${taskId}] Содержит в тексте: hsm_api_key=${hasHsmKeyString}, public_key=${hasPublicKeyString}, getDataAndEncr=${hasEncrString}`);
			
			// Диагностика: проверяем, что именно пришло в ответе используя cheerio
			let title = 'не найден';
			try {
				
				const $ = cheerio.load(html);

// берём все <script>
				let hsmApiKey: string | null = null;
				
				$('script').each((_, el) => {
					const scriptText = $(el).html();
					if (!scriptText) return;
					
					const match = scriptText.match(/hsm_api_key\s*=\s*['"]([^'"]+)['"]/);
					if (match) {
						hsmApiKey = match[1];
					}
				});
				
				console.log(hsmApiKey, '====================>>>>');
				
				title = $('title').text().trim() || 'не найден';
			} catch (error) {
				const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
				title = titleMatch ? titleMatch[1] : 'не найден';
			}
			this.logger.debug(`[${taskId}] Статус ответа: ${priceResponse.status}, заголовок страницы: "${title}"`);
			
			// Проверяем, не является ли это страницей авторизации используя cheerio
			let isAuthPage = false;
			try {
				const $ = cheerio.load(html);
				const pageTitle = $('title').text().trim();
				isAuthPage = pageTitle.includes('Авторизация') || html.includes('/user/auth') || html.includes('/user/login') || priceResponse.redirectedToAuth;
			} catch (error) {
				isAuthPage = html.includes('<title>Авторизация</title>') || html.includes('/user/auth') || html.includes('/user/login') || priceResponse.redirectedToAuth;
			}
			
			if (isAuthPage) {
				this.logger.warn(`[${taskId}] Получена страница авторизации, сессия истекла. Выполняем переавторизацию...`);
				
				// Выполняем переавторизацию
				await this.authService.login(true); // force=true для принудительной авторизации
				
				// Повторяем запрос после авторизации
				this.logger.log(`[${taskId}] Повторный запрос после авторизации...`);
				const retryResponse = await this.portalService.request({
					url: priceUrl,
					method: 'GET',
					additionalHeaders: {
						'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
						'Referer': `https://v3bl.goszakup.gov.kz/ru/application/show/${announceId}/${applicationId}`,
					},
				});
				
				if (!retryResponse.success || !retryResponse.data || typeof retryResponse.data !== 'string') {
					throw new Error('Не удалось получить HTML для ценовых предложений после переавторизации');
				}
				
				html = retryResponse.data as string;
				
				// Проверяем еще раз используя cheerio
				let isAuthPageRetry = false;
				try {
					const $ = cheerio.load(html);
					const pageTitle = $('title').text().trim();
					isAuthPageRetry = pageTitle.includes('Авторизация') || html.includes('/user/auth') || retryResponse.redirectedToAuth;
				} catch (error) {
					isAuthPageRetry = html.includes('<title>Авторизация</title>') || html.includes('/user/auth') || retryResponse.redirectedToAuth;
				}
				
				if (isAuthPageRetry) {
					throw new Error('После переавторизации все еще получаем страницу авторизации');
				}
				
				this.logger.log(`[${taskId}] HTML получен после переавторизации, размер: ${html.length} символов`);
			} else {
				// Логируем размер HTML для отладки
				this.logger.debug(`[${taskId}] Получен HTML размером ${html.length} символов`);
			}
			
			// 2. Извлекаем public_key из HTML используя cheerio
			let publicKeyFromHtml: string | null = null;
			try {
				const $ = cheerio.load(html);
				const $publicKeyInput = $('#public_key');
				if ($publicKeyInput.length > 0) {
					publicKeyFromHtml = $publicKeyInput.attr('value')?.trim() || null;
					if (publicKeyFromHtml) {
						this.logger.debug(`[${taskId}] public_key найден в HTML через cheerio: ${publicKeyFromHtml.substring(0, 50)}...`);
					}
				}
			} catch (error) {
				this.logger.error(`[${taskId}] Ошибка при извлечении public_key через cheerio: ${(error as Error).message}`);
			}
			
			if (!publicKeyFromHtml) {
				this.logger.warn(`[${taskId}] Не удалось извлечь public_key из HTML`);
			}
			
			// 3. Извлекаем buy_lot_point_id и hsm_api_key используя cheerio
			// buy_lot_point_id может быть как атрибут input (buy_lot_point_id="..."), так и аргумент в onclick getDataAndEncr(...)
			let buyLotPointId: string | null = null;
			
			let hsmApiKey: string | null = null;
			let lotKey: string | null = null;
			let offerName: string | null = null;
			let pointId: string | null = null;
			
			try {
				const $ = cheerio.load(html);
				
				// Извлечение buy_lot_point_id
				// Вариант 1: ищем input с атрибутом buy_lot_point_id
				const $inputWithBuyLotPointId = $('input[buy_lot_point_id]');
				if ($inputWithBuyLotPointId.length > 0) {
					const $firstInput = $inputWithBuyLotPointId.first();
					buyLotPointId = $firstInput.attr('buy_lot_point_id')?.trim() || null;
					pointId = $firstInput.attr('data-point_id')?.trim() || null;
					if (buyLotPointId) {
						this.logger.debug(`[${taskId}] buy_lot_point_id найден через cheerio (из input): ${buyLotPointId}, pointId: ${pointId}`);
					}
				}
				
				// Вариант 2: если не нашли, ищем в onclick атрибуте кнопки
				if (!buyLotPointId) {
					const $buttonWithOnclick = $('button[onclick*="getDataAndEncr"]');
					if ($buttonWithOnclick.length > 0) {
						const onclickAttr = $buttonWithOnclick.first().attr('onclick') || '';
						// Ищем getDataAndEncr(38374438, ...) - первый параметр это buy_lot_point_id
						const onclickMatch = onclickAttr.match(/getDataAndEncr\s*\(\s*(\d+)/i);
						if (onclickMatch && onclickMatch[1]) {
							buyLotPointId = onclickMatch[1].trim();
							this.logger.debug(`[${taskId}] buy_lot_point_id найден через cheerio (из onclick): ${buyLotPointId}`);
						}
					}
				}
				
				// Вариант 3: ищем в любом элементе с onclick, содержащим getDataAndEncr
				if (!buyLotPointId) {
					$('[onclick*="getDataAndEncr"]').each((i, elem) => {
						if (buyLotPointId) return false; // Прерываем, если уже нашли
						const onclickAttr = $(elem).attr('onclick') || '';
						const onclickMatch = onclickAttr.match(/getDataAndEncr\s*\(\s*(\d+)/i);
						if (onclickMatch && onclickMatch[1]) {
							buyLotPointId = onclickMatch[1].trim();
							this.logger.debug(`[${taskId}] buy_lot_point_id найден через cheerio (из onclick элемента): ${buyLotPointId}`);
							return false; // Прерываем цикл
						}
					});
				}
				
				// Дополнительно ищем pointId если еще не нашли
				if (!pointId) {
					const $pointIdInput = $('input[data-point_id]');
					if ($pointIdInput.length > 0) {
						pointId = $pointIdInput.first().attr('data-point_id')?.trim() || null;
						if (pointId) {
							this.logger.debug(`[${taskId}] pointId найден через cheerio (data-point_id): ${pointId}`);
						}
					}
				}
				
				// Извлечение hsm_api_key из script тегов
				$('script').each((i, elem) => {
					if (hsmApiKey) return false; // Прерываем, если уже нашли
					const scriptContent = $(elem).html() || '';
					
					// Ищем hsm_api_key = '...' (наиболее общий случай)
					// Учитываем возможные var, пробелы, табы, переносы строк и точку с запятой
					const match = scriptContent.match(/hsm_api_key\s*[:=]\s*['"]([^'"]+)['"]/i);
					if (match && match[1]) {
						hsmApiKey = match[1].trim();
						this.logger.debug(`[${taskId}] hsm_api_key найден через cheerio в script: ${hsmApiKey.substring(0, 30)}...`);
						return false;
					}
				});
				
				// Если cheerio не нашел в script тегах, пробуем найти во всем тексте HTML
				if (!hsmApiKey) {
					const globalMatch = html.match(/hsm_api_key\s*[:=]\s*['"]([^'"]+)['"]/i);
					if (globalMatch && globalMatch[1]) {
						hsmApiKey = globalMatch[1].trim();
						this.logger.debug(`[${taskId}] hsm_api_key найден через глобальный поиск: ${hsmApiKey.substring(0, 30)}...`);
					}
				}
				
				// Извлечение lotKey и offerName из input с классом offer_gamma
				if (buyLotPointId) {
					// Ищем input с классом offer_gamma и buy_lot_point_id равным buyLotPointId
					let $input = $(`input.offer_gamma[buy_lot_point_id="${buyLotPointId}"]`);
					
					// Если не нашли, пробуем по id
					if ($input.length === 0) {
						$input = $(`input#encrypted_${buyLotPointId}.offer_gamma`);
					}
					
					// Если все еще не нашли, пробуем найти любой input с нужным buy_lot_point_id
					if ($input.length === 0) {
						$input = $(`input[buy_lot_point_id="${buyLotPointId}"]`).filter((i, el) => {
							return $(el).hasClass('offer_gamma');
						});
					}
					
					if ($input.length > 0) {
						// Извлекаем value (lotKey)
						lotKey = $input.attr('value')?.trim() || null;
						if (lotKey) {
							this.logger.debug(`[${taskId}] lotKey найден через cheerio: ${lotKey.substring(0, 30)}...`);
						}
						
						// Извлекаем name (offerName)
						offerName = $input.attr('name')?.trim() || null;
						if (offerName) {
							this.logger.debug(`[${taskId}] offerName найден через cheerio: ${offerName}`);
						} else {
							this.logger.warn(`[${taskId}] Найден input элемент, но атрибут name отсутствует для buyLotPointId=${buyLotPointId}`);
						}
					} else {
						this.logger.warn(`[${taskId}] Не удалось найти input элемент для buyLotPointId=${buyLotPointId}`);
					}
				}
			} catch (error) {
				this.logger.error(`[${taskId}] Ошибка при извлечении данных через cheerio: ${(error as Error).message}`);
			}
			
			
			// Логируем для отладки
			this.logger.debug(`[${taskId}] Извлеченные значения: buyLotPointId=${buyLotPointId}, hsmApiKey=${hsmApiKey ? hsmApiKey.substring(0, 20) + '...' : 'null'}, lotKey=${lotKey ? lotKey.substring(0, 20) + '...' : 'null'}, offerName=${offerName || 'null'}`);
			
			if (!buyLotPointId || !hsmApiKey) {
				// Логируем фрагмент HTML для отладки
				const htmlSnippet = html.substring(0, 2000);
				this.logger.error(`[${taskId}] Не удалось извлечь: buyLotPointId=${buyLotPointId}, hsmApiKey=${hsmApiKey ? 'found' : 'not found'}`);
				this.logger.error(`[${taskId}] Фрагмент HTML (первые 2000 символов): ${htmlSnippet}`);
				
				// Пробуем найти любые упоминания
				if (html.includes('buy_lot_point_id')) {
					this.logger.error(`[${taskId}] buy_lot_point_id найден в HTML, но не удалось извлечь значение`);
				}
				if (html.includes('hsm_api_key')) {
					this.logger.error(`[${taskId}] hsm_api_key найден в HTML, но не удалось извлечь значение`);
				}
				
				throw new Error('Не удалось извлечь buy_lot_point_id или hsm_api_key из HTML');
			}
			
			downloadedData.buyLotPointId = buyLotPointId;
			downloadedData.hsmApiKey = hsmApiKey;
			if (lotKey) {
				downloadedData.lotKey = lotKey;
			}
			if (offerName) {
				downloadedData.offerName = offerName;
			}
			if (publicKeyFromHtml) {
				downloadedData.publicKey = publicKeyFromHtml;
			}
			
			// 4. Устанавливаем API key через crypto socket
			this.logger.log(`[${taskId}] Установка hsm_api_key через crypto socket...`);
			const setApiKeyResponse = await this.cryptoSocketService.sendTumarCSPRequest(
				'SetAPIKey',
				{apiKey: hsmApiKey},
				'SYSAPI',
			);
			
			// 5. Получаем версию через BaseAPI
			this.logger.log(`[${taskId}] Запрос версии через crypto socket (BaseAPI)...`);
			const versionResponse = await this.cryptoSocketService.sendTumarCSPRequest(
				'GetVersion',
				{type: 3},
				'BaseAPI',
			);
			
			const version = versionResponse?.response || versionResponse?.version || versionResponse?.data?.response;
			if (!version) {
				throw new Error('Не удалось получить версию из ответа crypto socket');
			}
			downloadedData.version = version;
			
			console.log(JSON.stringify({
				lpId: buyLotPointId,
				version: version,
			}))
			// 6. Получаем данные для шифрования от портала
			const encrUrl = `/ru/application/ajax_get_encr_info/${announceId}/${applicationId}`;
			const encrResponse = await this.portalService.request({
				url: encrUrl,
				method: 'POST',
				isFormData: false,
				data: {
					lpId: buyLotPointId,
					version: version,
				},
				additionalHeaders: {
					'Content-Type': 'application/x-www-form-urlencoded',
					'Accept': 'application/json, text/plain, */*',
					'Referer': `https://v3bl.goszakup.gov.kz${priceUrl}`,
				},
			});
			
			if (!encrResponse.success || !encrResponse.data) {
				this.logger.error(`[${taskId}] Не удалось получить данные для шифрования цены. Success: ${encrResponse.success}, Status: ${encrResponse.status}, Data type: ${typeof encrResponse.data}`);
				if (encrResponse.data) {
					this.logger.error(`[${taskId}] Содержимое ответа: ${JSON.stringify(encrResponse.data).substring(0, 2000)}`);
				}
				throw new Error('Не удалось получить данные для шифрования цены');
			}
			
			const encrData = encrResponse.data as any;
			
			console.log(JSON.stringify(encrData), 'encrData')
			
			const {minPrice, plnSum, salt, info, sign} = encrData;
			// Используем public_key из HTML, если он был извлечен, иначе из encrData, иначе fallback
			const publicKey = publicKeyFromHtml || encrData.public_key || null;
			
			if (!publicKey) {
				throw new Error('Не удалось получить public_key ни из HTML, ни из ответа ajax_get_encr_info');
			}
			
			this.logger.debug(`[${taskId}] Используется public_key: ${publicKey.substring(0, 50)}... (источник: ${publicKeyFromHtml ? 'HTML' : 'ajax_get_encr_info'})`);
			
			if (
				typeof minPrice !== 'number' ||
				typeof plnSum !== 'number' ||
				!salt ||
				!info ||
				!sign
			) {
				throw new Error('Ответ ajax_get_encr_info не содержит необходимые поля');
			}
			
			// Логируем полученные данные для отладки
			this.logger.debug(`[${taskId}] Получены данные для шифрования: minPrice=${minPrice}, plnSum=${plnSum}, salt=${salt.substring(0, 30)}..., info=${info.substring(0, 30)}..., sign=${sign.substring(0, 50)}...`);
			
			// Обрабатываем подпись: если она в URL-encoded формате, декодируем, иначе используем как есть
			let processedSign = sign;
			try {
				// Если подпись содержит URL-encoded символы (%), декодируем
				if (sign.includes('%')) {
					processedSign = decodeURIComponent(sign);
					this.logger.debug(`[${taskId}] Подпись после URL decode: ${processedSign.substring(0, 50)}...`);
				} else {
					// Подпись уже в base64 формате, используем как есть
					this.logger.debug(`[${taskId}] Подпись в base64 формате, используем как есть`);
				}
			} catch (error) {
				this.logger.warn(`[${taskId}] Не удалось обработать подпись, используем как есть: ${(error as Error).message}`);
				processedSign = sign;
			}
			
			downloadedData.encrInfo = encrData;
			
			console.log(JSON.stringify(downloadedData), 'downloadedData')
			console.log(publicKey, 'publicKey')
			
			// Сохраняем salt, info, sign в контекст для использования в callback
			const encrInfoForContext = {
				salt,
				info,
				sign,
			};
			
			// 6. Формируем данные и шифруем цену через crypto socket
			const encryptParams = {
				pl_sum: plnSum,
				d_sum: minPrice,
				d_messageUp: `Введенное значение превышает плановую сумму ${plnSum} тнг`,
				d_messageDown: `Введенное значение меньше демпинговой сумму ${minPrice} тнг`,
				id_priceoffer: info,
				public_key: publicKey,
				sign: processedSign, // Используем обработанную подпись
				salt: salt,
			};
			
			this.logger.debug(`[${taskId}] Параметры для EncryptOfferPrice: pl_sum=${plnSum}, d_sum=${minPrice}, id_priceoffer=${info}, sign=${processedSign.substring(0, 50)}..., salt=${salt.substring(0, 30)}...`);
			this.logger.debug(`[${taskId}] Полный запрос EncryptOfferPrice: ${JSON.stringify(encryptParams, null, 2)}`);
			
			this.logger.log(`[${taskId}] Отправка EncryptOfferPrice через crypto socket...`);
			
			// Устанавливаем контекст для callback
			this.cryptoSocketService.setEncryptOfferPriceContext({
				announceId,
				applicationId,
				buyLotPointId,
				pointId: pointId || buyLotPointId, // Используем pointId для ajax_save_gamma_signs
				taskId,
				encrInfo: encrInfoForContext, // salt, info, sign
				offerName: offerName || null, // name из input для ajax_priceoffers_next
			});
			
			// Отправляем запрос, обработка результата будет в callback handleEncryptOfferPriceResult
			this.cryptoSocketService.sendTumarCSPRequest(
				'EncryptOfferPrice',
				encryptParams,
				'EFCAPI',
			);
			
			await this.setData(minPrice + 500000);
			
			this.logger.log(`[${taskId}] Запрос EncryptOfferPrice отправлен, ожидаем обработку результата в callback...`);
			
			return {
				success: true,
				buyLotPointId,
				hsmApiKey,
				version,
				encrInfo: encrData,
				setApiKeyResponse,
				note: 'Обработка результата EncryptOfferPrice выполняется в callback handleEncryptOfferPriceResult',
			};
		} catch (error) {
			this.logger.error(`[${taskId}] Ошибка: ${(error as Error).message}`);
			throw error;
		}
	}
	
	/**
	 * Обработка результата EncryptOfferPrice из crypto socket
	 * Подписывает данные через ncanode и отправляет на портал
	 */
	private async handleEncryptOfferPriceResult(response: any, context?: any): Promise<void> {
		const taskId = context?.taskId || 'handleEncryptOfferPriceResult';
		const announceId = context?.announceId;
		const applicationId = context?.applicationId;
		const buyLotPointId = context?.buyLotPointId;
		const pointId = context?.pointId || buyLotPointId; // Извлекаем pointId
		const encrInfo = context?.encrInfo; // salt, info, sign
		const offerName = context?.offerName; // name из input для ajax_priceoffers_next
		
		this.logger.log(`[${taskId}] Обработка результата EncryptOfferPrice (pointId: ${pointId})...`);
		
		try {
			if (!response || response.result !== 'true' || !response.encryptData || !response.encryptKey) {
				this.logger.warn(`[${taskId}] Результат EncryptOfferPrice не содержит необходимые данные`);
				this.logger.debug(`[${taskId}] Ответ: ${JSON.stringify(response)}`);
				return;
			}
			
			if (!announceId || !applicationId || !buyLotPointId) {
				this.logger.error(`[${taskId}] Отсутствуют необходимые параметры: announceId=${announceId}, applicationId=${applicationId}, buyLotPointId=${buyLotPointId}`);
				return;
			}
			
			this.logger.log(`[${taskId}] Шифрование успешно, подписываем sessionKey через ncanode...`);
			
			// Подписываем encryptKey (sessionKey) через ncanode
			const certPath = this.configService.get<string>('CERT_PATH', '');
			const certPassword = this.configService.get<string>('CERT_PASSWORD', '');
			
			if (!certPath || !certPassword) {
				throw new Error('Не указан путь к сертификату или пароль для подписания');
			}
			
			this.logger.log(`[${taskId}] Подписание sessionKey через ncanode...`);
			
			// Формируем объект для подписи, как это делает NCALayer multitext
			// Используем pointId как ключ для данных подписи
			const dataToSign = JSON.stringify({
				[pointId]: response.encryptKey
			});
			
			const signedData = await this.ncanodeService.sign(
				response.encryptData,
				certPath,
				certPassword,
				true // с временной меткой
			);
			
			console.log(signedData, 'signedData')
			this.logger.log(`[${taskId}] SessionKey успешно подписан (multitext формат для pointId: ${pointId}) через ncanode`);
			
			// 1. Отправляем запрос на ajax_add_encrypt (первым, сразу после подписания)
			if (!encrInfo || !encrInfo.salt || !encrInfo.info || !encrInfo.sign) {
				this.logger.error(`[${taskId}] Недостаточно данных для отправки ajax_add_encrypt (отсутствуют salt, info или sign)`);
				return;
			}
			
			this.logger.log(`[${taskId}] Отправка запроса на ajax_add_encrypt...`);
			const addEncryptUrl = `/ru/application/ajax_add_encrypt/${announceId}/${applicationId}`;
			
			const addEncryptFormData: Record<string, any> = {
				'itemID': buyLotPointId,
				'encryptedData': response.encryptData,
				'sessionKey': response.encryptKey,
				'salt': encrInfo.salt,
				'info': response.sn,
				'sign': response.sign,
			};
			
			console.log(addEncryptFormData, 'addEncryptFormData')
			
			await this.portalService.request({
				url: addEncryptUrl,
				method: 'POST',
				data: addEncryptFormData,
				isFormData: true,
			});
			
			
			this.logger.log(`[${taskId}] Запрос на ajax_add_encrypt успешно отправлен`);
			
			
			// 2. Отправляем подписанные данные на портал (ajax_save_gamma_signs)
			this.logger.log(`[${taskId}] Отправка подписанных данных на портал...`);
			const saveUrl = `/ru/application/ajax_save_gamma_signs/${announceId}/${applicationId}`;
			// Формируем form data
			const formData: Record<string, any> = {};
			// xmlData[buyLotPointId] = encryptKey (sessionKey)
			formData[`xmlData[${buyLotPointId}]`] = response.encryptData;
			// signData[buyLotPointId] = CMS подпись sessionKey
			
			
			formData[`signData[${buyLotPointId}]`] = signedData.signature;
			
			this.logger.debug(`[${taskId}] Отправка signData form data: ${JSON.stringify(formData)}`);
			
			const saveResponse = await this.portalService.request({
				url: saveUrl,
				method: 'POST',
				data: formData,
				isFormData: true,
				additionalHeaders: {
					'Accept': 'application/json, text/javascript, */*; q=0.01',
					'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
					'Referer': `https://v3bl.goszakup.gov.kz/ru/application/priceoffers/${announceId}/${applicationId}`,
					'X-Requested-With': 'XMLHttpRequest',
				}
			});
			
			console.log(formData, 'formData')
			if (!saveResponse.success) {
				this.logger.error(`[${taskId}] Ошибка при отправке подписанных данных на портал: ${saveResponse.error || 'Unknown error'}`);
				if (saveResponse.data) {
					this.logger.error(`[${taskId}] Ответ портала: ${JSON.stringify(saveResponse.data)}`);
				}
				return;
			}
			
			this.logger.log(`[${taskId}] Подписанные данные успешно отправлены на портал`);
			
			// 4. Отправляем данные на ajax_priceoffers_next
			this.logger.log(`[${taskId}] Отправка данных на ajax_priceoffers_next...`);
			const nextUrl = `/ru/application/ajax_priceoffers_next/${announceId}/${applicationId}`;
			
			const nextFormData: Record<string, any> = {};
			
			// Используем offerName из HTML, если он был извлечен, иначе формируем вручную
			const formKey = offerName;
			nextFormData[formKey] = response.encryptData;
			// is_construction_pilot = пустая строка
			nextFormData['is_construction_pilot'] = '';
			console.log('ss' + offerName + "xxx")
			this.logger.debug(`[${taskId}] Используется ключ для form data: ${formKey}`);
			this.logger.debug(`[${taskId}] Отправка form data: ${formKey}=${response.encryptData.substring(0, 50)}..., is_construction_pilot=`);
			
			
			const nextResponse = await this.portalService.request({
				url: nextUrl,
				method: 'POST',
				data: nextFormData,
				isFormData: true,
			});
			
			
			console.log(nextResponse, 'nextResponse')
			if (nextResponse.success) {
				this.logger.log(`[${taskId}] Данные успешно отправлены на ajax_priceoffers_next`);
				
				// Отправляем запрос на публикацию заявки
				this.logger.log(`[${taskId}] Отправка запроса на публикацию заявки...`);
				const publicUrl = `/ru/application/ajax_public_application/${announceId}/${applicationId}`;
				
				const publicFormData: Record<string, any> = {
					'public_app': 'Y',
					'agree_price': 'false',
					'agree_contract_project': 'false',
					'agree_covid19': 'false',
				};
				
				const publicResponse = await this.portalService.request({
					url: publicUrl,
					method: 'POST',
					data: publicFormData,
					isFormData: true,
				});
				
				if (publicResponse.success) {
					this.logger.log(`[${taskId}] Запрос на публикацию заявки успешно отправлен`);
				} else {
					this.logger.error(`[${taskId}] Ошибка при отправке запроса на публикацию заявки: ${publicResponse.error || 'Unknown error'}`);
				}
			} else {
				this.logger.error(`[${taskId}] Ошибка при отправке данных на ajax_priceoffers_next: ${nextResponse.error || 'Unknown error'}`);
				if (nextResponse.data) {
					this.logger.error(`[${taskId}] Ответ портала: ${JSON.stringify(nextResponse.data)}`);
				}
			}
			
			this.logger.log(`[${taskId}] Обработка результата EncryptOfferPrice завершена успешно`);
			// console.timeEnd('application')
		} catch (error) {
			this.logger.error(`[${taskId}] Ошибка при обработке результата EncryptOfferPrice: ${(error as Error).message}`);
			throw error;
		}
	}
	
	/**
	 * Ввод данных в модальное окно после успешного шифрования цены
	 * Отправляет запрос на внешний сервис для заполнения инпута и клика по кнопке
	 */
	async setData(minPrice: number): Promise<void> {
		const taskId = 'setData';
		this.logger.log(`[${taskId}] Начало ввода данных в модальное окно...`);
		
		try {
			const inputX = parseInt(this.configService.get<string>('INPUT_X', '790'), 10);
			const inputY = parseInt(this.configService.get<string>('INPUT_Y', '322'), 10);
			const buttonX = parseInt(this.configService.get<string>('BUTTON_X', '828'), 10);
			const buttonY = parseInt(this.configService.get<string>('BUTTON_Y', '432'), 10);
			const robotogoUrl = this.configService.get<string>('ROBOTOGO_URL', 'http://localhost:3001/api/robotogo/fill-and-click');
			
			const requestBody = {
				input_x: inputX,
				input_y: inputY,
				text: String(minPrice),
				button_x: buttonX,
				button_y: buttonY,
				button: 'left'
			};
			
			this.logger.log(`[${taskId}] Отправка запроса на ${robotogoUrl} с данными:`, requestBody);
			
			const response = await axios.post(robotogoUrl, requestBody, {
				headers: {
					'Content-Type': 'application/json'
				},
				timeout: 10000
			});
			
			this.logger.log(`[${taskId}] Данные успешно введены в модальное окно. Ответ сервера:`, response.status);
		} catch (error) {
			this.logger.error(`[${taskId}] Ошибка при вводе данных: ${(error as Error).message}`);
			throw error;
		}
	}
	
	
	async getIdDataSheetHandle(announceId: string, applicationId: string, docId: string, index: string = '1'): Promise<string | null> {
		const taskId = `getIdDataSheetHandle-${announceId}-${applicationId}-${docId}`;
		this.logger.log(`[${taskId}] Получение ID из ссылки для документа ${docId}...`);
		
		try {
			// Отправляем GET запрос на страницу документа с повторными попытками
			const docUrl = `/ru/application/show_doc/${announceId}/${applicationId}/${docId}`;
			const response = await this.retryRequest(
				async () => {
					const resp = await this.portalService.request({
						url: docUrl,
						method: 'GET',
						additionalHeaders: {
							'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
							'Referer': `https://v3bl.goszakup.gov.kz/ru/application/show/${announceId}/${applicationId}`,
						},
					});
					
					if (!resp.success || !resp.data || typeof resp.data !== 'string') {
						throw new Error('Не удалось получить HTML страницы документа');
					}
					
					return resp;
				},
				taskId,
				3,
				1000
			);
			
			let html = response.data as string;
			
			// Проверяем авторизацию и переавторизуемся при необходимости
			const reauthHtml = await this.checkAndReauthIfNeeded(
				html,
				response,
				taskId,
				docUrl,
				{
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'Referer': `https://v3bl.goszakup.gov.kz/ru/application/show/${announceId}/${applicationId}`,
				}
			);
			if (reauthHtml) {
				html = reauthHtml;
			}
			
			// Используем метод из HtmlParserService для извлечения ID
			const extractedId = this.htmlParserService.extractIdFromDataSheetLink(html, announceId, docId, index);
			
			if (extractedId) {
				this.logger.log(`[${taskId}] ID найден: ${extractedId}`);
				return extractedId;
			}
			
			// Детальная диагностика, если не нашли
			this.logger.warn(`[${taskId}] Не удалось извлечь ID из HTML`);
			this.logger.debug(`[${taskId}] HTML превью (первые 15000 символов): ${html.substring(0, 15000)}`);
			
			// Ищем все ссылки с show_doc для отладки
			const allShowDocLinks = html.match(/show_doc\/[\d]+\/[\d]+\/[\d]+\/[\d]+\/[\d]+/gi);
			if (allShowDocLinks) {
				this.logger.debug(`[${taskId}] Найдено ссылок с show_doc: ${allShowDocLinks.length}`);
				allShowDocLinks.slice(0, 5).forEach((link, idx) => {
					this.logger.debug(`[${taskId}] Ссылка ${idx + 1}: ${link}`);
				});
			}
			
			// Ищем все упоминания "Дополнение" в HTML
			const appendixMentions = html.match(/Дополнение[^<]*/gi);
			if (appendixMentions) {
				this.logger.debug(`[${taskId}] Найдено упоминаний "Дополнение": ${appendixMentions.length}`);
				appendixMentions.slice(0, 5).forEach((mention, idx) => {
					this.logger.debug(`[${taskId}] Упоминание ${idx + 1}: ${mention.substring(0, 150)}`);
				});
			}
			
			return null;
		} catch (error) {
			this.logger.error(`[${taskId}] Ошибка при получении ID: ${(error as Error).message}`);
			throw error;
		}
	}
	
	/**
	 * Обработка листа данных для конкретного лота
	 * @param announceId - ID объявления
	 * @param applicationId - ID заявки
	 * @param docId - ID документа
	 * @param lotId - ID лота
	 * @param index - Индекс (обычно 1)
	 */
	async dataSheetHandle(announceId: string, applicationId: string, docId: string, lotId: string, index: string = '1'): Promise<any> {
		this.logger.log(`Обработка листа данных для документа ${docId}, лот ${lotId}, индекс ${index}...`);
		
		const taskId = `dataSheetHandle-${docId}-${lotId}-${index}`;
		const docUrl = `/ru/application/show_doc/${announceId}/${applicationId}/${docId}/${lotId}/${index}`;
		
		try {
			// Шаг 1: Отправить GET запрос для получения HTML с data-url и fileIdentifier
			this.logger.log(`[${taskId}] Отправка GET запроса на ${docUrl}...`);
			
			const getResponse = await this.portalService.request({
				url: docUrl,
				method: 'GET',
				additionalHeaders: {
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'Referer': `https://v3bl.goszakup.gov.kz/ru/application/show/${announceId}/${applicationId}`,
				}
			});
			
			
			// Проверяем на 403 ошибку ПЕРЕД проверкой success (403 может приходить с success=false)
			if (getResponse.status === 403) {
				this.logger.warn(`[${taskId}] Получена ошибка 403. Нет доступа к документу.`);
				return {
					success: false,
					status: 403,
					error: 'Доступ запрещен (403)',
					message: 'Нет доступа к документу или заявке',
					accessDenied: true,
				};
			}
			
			if (!getResponse.success || !getResponse.data || typeof getResponse.data !== 'string') {
				throw new Error('Не удалось получить HTML ответ от сервера');
			}
			
			let html = getResponse.data as string;
			
			// Проверяем на страницу "access_denied" в HTML
			if (html.includes('access_denied') || (html.includes('error_report') && html.includes('access_denied')) || html.includes('error_report') && html.includes('access_denied')) {
				this.logger.warn(`[${taskId}] Получена страница "access_denied". Нет доступа к документу.`);
				return {
					success: false,
					status: 403,
					error: 'Доступ запрещен (403)',
					message: 'Нет доступа к документу или заявке',
					accessDenied: true,
				};
			}
			
			// Проверяем, не является ли это страницей авторизации используя cheerio
			let isAuthPage = false;
			try {
				const $ = cheerio.load(html);
				const pageTitle = $('title').text().trim();
				isAuthPage = pageTitle.includes('Авторизация') || html.includes('/user/auth') || html.includes('/user/login') || getResponse.redirectedToAuth;
			} catch (error) {
				isAuthPage = html.includes('<title>Авторизация</title>') || html.includes('/user/auth') || html.includes('/user/login') || getResponse.redirectedToAuth;
			}
			
			if (isAuthPage) {
				this.logger.warn(`[${taskId}] Получена страница авторизации, сессия истекла. Выполняем переавторизацию...`);
				
				
				// Выполняем переавторизацию
				await this.authService.login(true);
				
				// Повторяем запрос после авторизации
				this.logger.log(`[${taskId}] Повторный запрос после авторизации...`);
				const retryResponse = await this.portalService.request({
					url: docUrl,
					method: 'GET',
					additionalHeaders: {
						'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
						'Referer': `https://v3bl.goszakup.gov.kz/ru/application/show/${announceId}/${applicationId}`,
					}
				});
				
				if (!retryResponse.success || !retryResponse.data || typeof retryResponse.data !== 'string') {
					throw new Error('Не удалось получить HTML после переавторизации');
				}
				
				html = retryResponse.data as string;
				
				// Проверяем еще раз используя cheerio
				let isAuthPageRetry = false;
				try {
					const $ = cheerio.load(html);
					const pageTitle = $('title').text().trim();
					isAuthPageRetry = pageTitle.includes('Авторизация') || html.includes('/user/auth') || retryResponse.redirectedToAuth;
				} catch (error) {
					isAuthPageRetry = html.includes('<title>Авторизация</title>') || html.includes('/user/auth') || retryResponse.redirectedToAuth;
				}
				
				if (isAuthPageRetry) {
					throw new Error('После переавторизации все еще получаем страницу авторизации');
				}
			}
			
			// Шаг 1.5: Извлечь ID из ссылки "Дополнение к тех. спец." если не передан или для проверки
			let extractedLotId: string | null = null;
			try {
				const $ = cheerio.load(html);
				
				// Ищем ссылку с текстом "Дополнение к тех. спец."
				$('a').each((i, elem) => {
					if (extractedLotId) return false; // Прерываем, если уже нашли
					
					const $link = $(elem);
					const href = $link.attr('href') || '';
					const linkText = $link.text().trim();
					const normalizedText = linkText.toLowerCase();
					
					// Проверяем, содержит ли текст ссылки "Дополнение к тех. спец."
					if (normalizedText.includes('дополнение') &&
						(normalizedText.includes('тех') || normalizedText.includes('тех.')) &&
						normalizedText.includes('спец')) {
						
						// Извлекаем ID из href: show_doc/{announceId}/{applicationId}/{docId}/{id}/{index}
						// Пример: show_doc/15834014/68100360/3357/79988804/2
						const idMatch = href.match(/\/show_doc\/[\d]+\/[\d]+\/[\d]+\/(\d+)\/[\d]+/i);
						
						if (idMatch && idMatch[1]) {
							extractedLotId = idMatch[1].trim();
							this.logger.debug(`[${taskId}] ID извлечен из ссылки "Дополнение к тех. спец." через cheerio: ${extractedLotId}, href: "${href}"`);
							return false; // Прерываем цикл
						}
					}
				});
				
				// Если нашли ID и он отличается от переданного, используем извлеченный
				if (extractedLotId && extractedLotId !== lotId) {
					this.logger.log(`[${taskId}] Найден ID из ссылки (${extractedLotId}) отличается от переданного (${lotId}). Используем извлеченный ID.`);
					lotId = extractedLotId;
				} else if (extractedLotId) {
					this.logger.debug(`[${taskId}] Извлеченный ID (${extractedLotId}) совпадает с переданным (${lotId})`);
				} else if (!extractedLotId && lotId) {
					this.logger.debug(`[${taskId}] ID не найден в ссылке "Дополнение к тех. спец.", используем переданный: ${lotId}`);
				}
			} catch (error) {
				this.logger.error(`[${taskId}] Ошибка при извлечении ID из ссылки через cheerio: ${(error as Error).message}`);
			}
			
			// Шаг 2: Извлечь все data-url и fileIdentifier из блоков add_signature_block
			const allFileData = this.htmlParserService.extractAllSignatureButtonData(html);
			
			if (allFileData.length === 0) {
				// Диагностика: логируем фрагмент HTML для отладки
				const htmlPreview = html.substring(0, 20000);
				this.logger.error(`[${taskId}] Не удалось извлечь data-url или fileIdentifier из HTML`);
				
				// Проверяем наличие ключевых элементов
				const hasAddSignatureBlock = html.includes('add_signature_block');
				const hasBtnAddSignature = html.includes('btn-add-signature');
				const hasDataUrl = html.includes('data-url');
				const hasDataFileIdentifier = html.includes('data-file-identifier');
				const hasTable = html.includes('<table') || html.includes('<tbody>');
				const hasFileRow = html.includes('file_row_');
				const hasDownloadFile = html.includes('download_file');
				
				this.logger.error(`[${taskId}] Диагностика: hasAddSignatureBlock=${hasAddSignatureBlock}, hasBtnAddSignature=${hasBtnAddSignature}, hasDataUrl=${hasDataUrl}, hasDataFileIdentifier=${hasDataFileIdentifier}, hasTable=${hasTable}, hasFileRow=${hasFileRow}, hasDownloadFile=${hasDownloadFile}`);
				
				// Ищем таблицы в HTML
				if (hasTable) {
					const tableMatches = html.match(/<table[^>]*>([\s\S]{0,5000})<\/table>/gi);
					if (tableMatches) {
						this.logger.debug(`[${taskId}] Найдено таблиц: ${tableMatches.length}`);
						tableMatches.slice(0, 1).forEach((table, idx) => {
							this.logger.debug(`[${taskId}] Таблица ${idx + 1}: ${table.substring(0, 2000)}`);
						});
					}
				}
				
				// Ищем строки с file_row
				if (hasFileRow) {
					const fileRowMatches = html.match(/<td[^>]*id=["']file_row_\d+["'][^>]*>([\s\S]{0,2000})<\/td>/gi);
					if (fileRowMatches) {
						this.logger.debug(`[${taskId}] Найдено строк с file_row: ${fileRowMatches.length}`);
						fileRowMatches.slice(0, 2).forEach((row, idx) => {
							this.logger.debug(`[${taskId}] Строка file_row ${idx + 1}: ${row.substring(0, 1000)}`);
						});
					}
				}
				
				// Пробуем найти любые блоки с подписями для отладки
				const signatureBlocks = html.match(/<div[^>]*class=["'][^"']*add_signature[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi);
				if (signatureBlocks) {
					this.logger.debug(`[${taskId}] Найдено блоков с add_signature: ${signatureBlocks.length}`);
					signatureBlocks.slice(0, 2).forEach((block, idx) => {
						this.logger.debug(`[${taskId}] Блок ${idx + 1}: ${block.substring(0, 500)}`);
					});
				}
				
				// Пробуем найти любые кнопки с data-url для отладки
				const buttonsWithDataUrl = html.match(/<button[^>]*data-url[^>]*>/gi);
				if (buttonsWithDataUrl) {
					this.logger.debug(`[${taskId}] Найдено кнопок с data-url: ${buttonsWithDataUrl.length}`);
					buttonsWithDataUrl.slice(0, 2).forEach((btn, idx) => {
						this.logger.debug(`[${taskId}] Кнопка ${idx + 1}: ${btn.substring(0, 500)}`);
					});
				}
				
				// Ищем ссылки на download_file
				if (hasDownloadFile) {
					const downloadLinks = html.match(/<a[^>]*href=["'][^"']*download_file[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi);
					if (downloadLinks) {
						this.logger.debug(`[${taskId}] Найдено ссылок на download_file: ${downloadLinks.length}`);
						downloadLinks.slice(0, 3).forEach((link, idx) => {
							this.logger.debug(`[${taskId}] Ссылка ${idx + 1}: ${link.substring(0, 500)}`);
						});
					}
				}
				
				// Проверяем, может быть файлы уже подписаны или страница пустая
				const hasSigned = html.includes('подписан') || html.includes('Подписан') || html.includes('signed');
				const hasNoFiles = html.includes('нет файлов') || html.includes('файлы не найдены') || html.includes('no files');
				
				// Проверяем наличие зеленых галочек (признак подписанного файла)
				const hasGreenCheck = html.includes('glyphicon-check') && html.includes('color: green');
				const hasCheckIcon = html.includes('glyphicon-check');
				
				// Подсчитываем количество файлов в таблице
				const fileRows = html.match(/<tr>[\s\S]*?download_file[\s\S]*?<\/tr>/gi);
				const fileCount = fileRows ? fileRows.length : 0;
				
				// Подсчитываем количество подписанных файлов (с галочкой)
				const signedFileRows = html.match(/<tr>[\s\S]*?glyphicon-check[\s\S]*?color:\s*green[\s\S]*?<\/tr>/gi);
				const signedCount = signedFileRows ? signedFileRows.length : 0;
				
				this.logger.warn(`[${taskId}] Дополнительная диагностика: hasSigned=${hasSigned}, hasNoFiles=${hasNoFiles}, hasGreenCheck=${hasGreenCheck}, hasCheckIcon=${hasCheckIcon}, fileCount=${fileCount}, signedCount=${signedCount}`);
				
				// Если все файлы подписаны (есть галочки и нет блоков подписания)
				if (hasGreenCheck && fileCount > 0 && signedCount >= fileCount && !hasAddSignatureBlock && !hasBtnAddSignature) {
					this.logger.log(`[${taskId}] Все файлы уже подписаны (${signedCount}/${fileCount}). Пропускаем подписание.`);
					return {
						success: true,
						status: 200,
						filesCount: fileCount,
						signedCount: signedCount,
						fileIdentifiers: [],
						message: 'Все файлы уже подписаны',
						response: html.substring(0, 1000),
					};
				}
				
				// Если нет файлов для подписания, это не ошибка - просто возвращаем успешный результат
				if (hasNoFiles || (!hasAddSignatureBlock && !hasBtnAddSignature && !hasDataUrl && !hasDownloadFile)) {
					this.logger.warn(`[${taskId}] На странице нет файлов для подписания. Возможно, файлы уже подписаны или еще не загружены.`);
					return {
						success: true,
						status: 200,
						filesCount: 0,
						fileIdentifiers: [],
						message: 'Нет файлов для подписания на странице',
						response: html.substring(0, 1000),
					};
				}
				
				throw new Error('Не удалось извлечь data-url или fileIdentifier из HTML');
			}
			
			this.logger.log(`[${taskId}] Найдено файлов для обработки: ${allFileData.length}. Скачивание и подписание — параллельно.`);
			
			// Шаг 3: Скачать и подписать все файлы параллельно
			const processOneFile = async (fileData: { dataUrl: string; fileIdentifier: string; filename?: string }): Promise<{ fileIdentifier: string; signature: string }> => {
				const fileTaskId = `${taskId}-${fileData.fileIdentifier}`;
				this.logger.log(`[${fileTaskId}] Скачивание файла ${fileData.dataUrl}${fileData.filename ? ` (имя: ${fileData.filename})` : ''}...`);
				const { fileBuffer, ext } = await this.appendixService.downloadFile(fileData.dataUrl, fileTaskId, fileData.filename, true);
				this.logger.log(`[${fileTaskId}] Файл скачан (${fileBuffer.length} байт), расширение: ${ext}. Подписание...`);
				const signedDocument = await this.appendixService.signFile(fileBuffer, ext, fileTaskId, fileData.dataUrl, true);
				this.logger.log(`[${fileTaskId}] Файл подписан`);
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
				this.logger.log(`[${fileTaskId}] Подпись извлечена, длина: ${signature.length}`);
				return { fileIdentifier: fileData.fileIdentifier, signature };
			};

			const fileSignatures = await Promise.all(allFileData.map((fileData) => processOneFile(fileData)));
			
			// Шаг 4: Отправить POST запрос со всеми подписями
			this.logger.log(`[${taskId}] Отправка POST запроса с ${fileSignatures.length} подписями...`);
			
			const formData: Record<string, any> = {
				'send': 'Сохранить',
				'sign_files': '',
			};
			
			for (const fileSig of fileSignatures) {
				formData[`signature[${fileSig.fileIdentifier}]`] = fileSig.signature;
			}
			
			
			console.log(formData, 'formData')
			const postResponse = await this.portalService.request({
				url: docUrl,
				method: 'POST',
				isFormData: true,
				data: formData,
				additionalHeaders: {
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'Referer': `https://v3bl.goszakup.gov.kz${docUrl}`,
				}
			});
			
			
			this.logger.log(`[${taskId}] POST запрос отправлен.dataSheetHandle  Статус: ${postResponse.status}, подписей: ${fileSignatures.length} }`);
			this.logger.log(`[${taskId}] POST запрос отправлен.dataSheetHandle  Статус: ${postResponse.data}, ================================> }`);
			
			return {
				success: postResponse.success,
				status: postResponse.status,
				filesCount: fileSignatures.length,
				fileIdentifiers: fileSignatures.map(fs => fs.fileIdentifier),
				response: postResponse.data,
			};
		} catch (error) {
			this.logger.error(`[${taskId}] Ошибка обработки листа данных: ${(error as Error).message}`);
			throw error;
		}
	}
	
	/**
	 * Обработка листа данных для конкретного лота с несколькими индексами
	 * Обрабатывает последовательно индексы 1 и 2
	 * @param announceId - ID объявления
	 * @param applicationId - ID заявки
	 * @param docId - ID документа
	 * @param lotId - ID лота
	 */
	async dataSheetHandleMultiple(announceId: string, applicationId: string, docId: string, lotId: string): Promise<any> {
		this.logger.log(`Обработка листа данных для документа ${docId}, лот ${lotId} (индексы 1 и 2)...`);
		
		const results: Array<{ index: string; success: boolean; result?: any; error?: string }> = [];
		
		// Обрабатываем индекс 1
		try {
			this.logger.log(`Обработка индекса 1...`);
			const result1 = await this.dataSheetHandle(announceId, applicationId, docId, lotId, '1');
			results.push({index: '1', success: true, result: result1});
		} catch (error) {
			this.logger.error(`Ошибка обработки индекса 1: ${(error as Error).message}`);
			results.push({index: '1', success: false, error: (error as Error).message});
		}
		
		// Обрабатываем индекс 2
		try {
			this.logger.log(`Обработка индекса 2...`);
			const result2 = await this.dataSheetHandle(announceId, applicationId, docId, lotId, '2');
			results.push({index: '2', success: true, result: result2});
		} catch (error) {
			this.logger.error(`Ошибка обработки индекса 2: ${(error as Error).message}`);
			results.push({index: '2', success: false, error: (error as Error).message});
		}
		
		const allSuccess = results.every(r => r.success);
		
		return {
			success: allSuccess,
			results,
		};
	}
}




































































































































































































































