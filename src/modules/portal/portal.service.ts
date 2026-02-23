import {Injectable, Logger} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {HttpService} from '../http/http.service';
import {RedisService} from '../redis/redis.service';
import * as crypto from 'crypto';

/**
 * Сервис для работы с порталом goszakup.gov.kz
 * Предоставляет высокоуровневые методы для работы с API портала
 */
@Injectable()
export class PortalService {
	private readonly logger = new Logger(PortalService.name);
	private readonly htmlCacheKeyPrefix = 'html:cache:';
	private readonly htmlCacheTtl = 5 * 60; // 5 минут для HTML страниц
	private readonly enableHtmlCache: boolean; // Можно отключить через конфиг
	
	constructor(
		private httpService: HttpService,
		private configService: ConfigService,
		private redisService: RedisService,
	) {
		this.enableHtmlCache = this.configService.get<boolean>('ENABLE_HTML_CACHE', false);
	}
	
	/**
	 * Получить главную страницу портала
	 */
	async getHomePage() {
		this.logger.log('Получение главной страницы...');
		return this.request({
			url: '/',
			method: 'GET',
		});
	}
	
	/**
	 * Получить ключ для подписи (для авторизации)
	 * @returns {Promise<string>} Ключ для подписи
	 */
	async getAuthKey(): Promise<string> {
		try {
			this.logger.log('Получение ключа для авторизации...');
			const response = await this.httpService.post(
				'/ru/user/sendkey/kz',
				{},
				{
					headers: {
						'Content-Type': 'application/x-www-form-urlencoded',
					},
				},
			);
			
			// Извлекаем ключ из ответа
			const key = this.extractKeyFromResponse(response);
			if (!key) {
				throw new Error('Не удалось получить ключ для подписи');
			}
			
			this.logger.log(`Ключ получен: ${key}`);
			return key;
		} catch (error) {
			this.logger.error(`Ошибка получения ключа: ${error.message}`);
			throw error;
		}
	}
	
	/**
	 * Отправить подписанный XML для авторизации
	 * @param {string} signedXml - Подписанный XML
	 * @returns {Promise<any>} Результат авторизации
	 */
	async sendSignedXml(signedXml: string) {
		try {
			this.logger.log('Отправка подписанного XML для авторизации...');
			const response = await this.httpService.postFormData('/user/sendsign/kz', {
				sign: signedXml,
			}, {
				maxRedirects: 5,
				validateStatus: (status) => status < 500, // Разрешаем все статусы кроме 5xx
			});
			
			// Cookies автоматически сохраняются в CookieJar через response interceptor
			// Но мы также возвращаем их в ответе для информации
			const setCookieHeaders = response.headers['set-cookie'] || [];
			
			// Детальное логирование ответа авторизации
			this.logger.log(`=== Ответ на авторизацию ===`);
			this.logger.log(`Статус: ${response.status} ${response.statusText || ''}`);
			this.logger.log(`Cookies получено: ${setCookieHeaders.length}`);
			
			// Логируем все заголовки ответа
			this.logger.debug(`Заголовки ответа:`);
			Object.keys(response.headers).forEach(key => {
				if (key.toLowerCase() === 'set-cookie') {
					this.logger.debug(`  ${key}: [${setCookieHeaders.length} cookies]`);
				} else {
					const value = response.headers[key];
					const valueStr = Array.isArray(value) ? value.join(', ') : String(value);
					// Ограничиваем длину значения заголовка
					const preview = valueStr.length > 200 ? valueStr.substring(0, 200) + '...' : valueStr;
					this.logger.debug(`  ${key}: ${preview}`);
				}
			});
			
			// Логируем тело ответа (первые 500 символов)
			if (response.data) {
				const dataStr = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
				const dataPreview = dataStr.length > 500 ? dataStr.substring(0, 500) + '...' : dataStr;
				this.logger.debug(`Тело ответа (первые 500 символов):\n${dataPreview}`);
			}
			
			// Если был редирект, логируем его
			if (response.status === 302 || response.status === 301) {
				const location = response.headers.location || '';
				this.logger.log(`🔄 Редирект после авторизации: ${location}`);
				
				// Если редирект на auth_confirm, это нормально
				if (location.includes('auth_confirm')) {
					this.logger.log('✅ Редирект на страницу подтверждения авторизации - это ожидаемо');
				}
			}
			
			// Логируем все cookies
			if (setCookieHeaders.length > 0) {
				this.logger.log(`Все полученные cookies (${setCookieHeaders.length}):`);
				setCookieHeaders.forEach((cookie: string, index: number) => {
					const cookieName = cookie.split('=')[0];
					const cookiePreview = cookie.length > 100 ? cookie.substring(0, 100) + '...' : cookie;
					this.logger.log(`  Cookie ${index + 1}: ${cookieName} (${cookiePreview})`);
				});
			}
			
			// Логируем сессионные cookies
			const sessionCookies = setCookieHeaders.filter((cookie: string) =>
				cookie.toLowerCase().includes('session') ||
				cookie.toLowerCase().includes('sid') ||
				cookie.toLowerCase().includes('jsessionid') ||
				cookie.toLowerCase().includes('ci_session')
			);
			if (sessionCookies.length > 0) {
				this.logger.log(`✅ Получены сессионные cookies: ${sessionCookies.length}`);
				sessionCookies.forEach((cookie: string) => {
					const cookieName = cookie.split('=')[0];
					this.logger.log(`  Сессионный cookie: ${cookieName}`);
				});
			} else {
				this.logger.warn('⚠️ Сессионные cookies не найдены в ответе');
			}
			
			// Проверяем, не вернулась ли страница логина (признак неуспешной авторизации)
			const responseData = typeof response.data === 'string' ? response.data : String(response.data);
			const isLoginPage = responseData.includes('<title>Авторизация</title>') || 
			                    responseData.includes('user/login') ||
			                    responseData.includes('window.current_method = "login"') ||
			                    responseData.includes('id="selectP12File"');
			
			if (isLoginPage) {
				this.logger.error('❌ Авторизация не удалась: в ответе пришла страница логина');
				this.logger.error('Возможные причины:');
				this.logger.error('1. Неправильная подпись XML');
				this.logger.error('2. Сертификат недействителен или истек');
				this.logger.error('3. Неправильный формат подписанного XML');
				this.logger.error('4. Cookies не сохранились');
			}
			
			this.logger.log(`=== Конец ответа на авторизацию ===`);
			
			// Авторизация считается успешной только если:
			// 1. Статус 200 или 302
			// 2. И НЕ пришла страница логина
			const success = (response.status === 200 || response.status === 302) && !isLoginPage;
			
			return {
				success: success,
				status: response.status,
				data: response.data,
				headers: this.sanitizeHeaders(response.headers),
				cookies: setCookieHeaders,
				isLoginPage: isLoginPage, // Добавляем флаг для проверки
			};
		} catch (error) {
			this.logger.error(`Ошибка отправки подписанного XML: ${(error as Error).message}`);
			if ((error as any).response) {
				this.logger.error(`Статус ответа: ${(error as any).response.status}`);
				this.logger.error(`Заголовки: ${JSON.stringify((error as any).response.headers)}`);
			}
			throw error;
		}
	}
	
	/**
	 * Получить информацию о пользователе
	 */
	async getUserInfo() {
		try {
			this.logger.log('Получение информации о пользователе...');
			const response = await this.httpService.get('/api/user/info', {
				validateStatus: (status) => status < 500,
			});
			
			return {
				success: response.status === 200,
				status: response.status,
				data: response.data,
			};
		} catch (error) {
			this.logger.error(`Ошибка получения информации о пользователе: ${error.message}`);
			throw error;
		}
	}



	/**
	 * Отправить заявку
	 * @param {object} applicationData - Данные заявки
	 */
	async submitApplication(applicationData: any) {
		try {
			this.logger.log('Отправка заявки...');
			const response = await this.httpService.post('/api/applications/submit', applicationData);
			
			return {
				success: response.status === 200 || response.status === 201,
				status: response.status,
				data: response.data,
				applicationId: response.data?.id || response.data?.applicationId,
			};
		} catch (error) {
			this.logger.error(`Ошибка отправки заявки: ${error.message}`);
			if ((error as any).response) {
				return {
					success: false,
					status: (error as any).response.status,
					error: (error as any).response.data,
				};
			}
			throw error;
		}
	}
	
	/**
	 * Получить статус заявки
	 * @param {string} applicationId - ID заявки
	 */
	async getApplicationStatus(applicationId: string) {
		try {
			this.logger.log(`Получение статуса заявки ${applicationId}...`);
			const response = await this.httpService.get(`/api/applications/${applicationId}/status`);
			
			return {
				success: true,
				data: response.data,
				status: response.status,
			};
		} catch (error) {
			this.logger.error(`Ошибка получения статуса заявки: ${error.message}`);
			throw error;
		}
	}
	
	/**
	 * Получить список заявок пользователя
	 * @param {object} filters - Фильтры
	 */
	async getUserApplications(filters: any = {}) {
		try {
			this.logger.log('Получение списка заявок пользователя...');
			const response = await this.httpService.get('/api/applications', {
				params: filters,
			});
			
			return {
				success: true,
				data: response.data,
				status: response.status,
			};
		} catch (error) {
			this.logger.error(`Ошибка получения списка заявок: ${error.message}`);
			throw error;
		}
	}
	
	/**
	 * Подтверждение авторизации (auth_confirm)
	 * Отправляет пароль и согласие на обработку данных
	 * @param {string} password - Пароль пользователя
	 * @returns {Promise<any>} Результат подтверждения авторизации
	 */
	async authConfirm(password: string) {
		try {
			this.logger.log('Подтверждение авторизации (auth_confirm)...');
			
			const baseURL = this.configService.get<string>('PORTAL_BASE_URL', 'https://v3bl.goszakup.gov.kz');
			const authConfirmReferer = `${baseURL}/ru/user/auth_confirm`;
			
			// Шаг 1: Сначала получаем страницу auth_confirm, чтобы обновить сессию и получить правильные cookies
			this.logger.log('Получение страницы auth_confirm перед отправкой POST...');
			
			await this.request({
				url: '/ru/user/auth_confirm',
				method: 'GET',
				referer: authConfirmReferer,
			});
			
			// Шаг 2: Отправляем POST запрос с правильными заголовками
			this.logger.log('Отправка POST запроса на auth_confirm...');
			
			const response = await this.request({
				url: '/ru/user/auth_confirm',
				method: 'POST',
				data: {
					password: password,
					agreed_check: 'on',
				},
				referer: authConfirmReferer,
				additionalHeaders: {
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
				}
			});
			
			// Детальное логирование ответа на подтверждение авторизации
			this.logger.log(`=== Ответ на подтверждение авторизации (auth_confirm) ===`);
			this.logger.log(`Статус: ${response.status}`);
			this.logger.log(`Success: ${response.success}`);
			this.logger.log(`RedirectedToAuth: ${response.redirectedToAuth}`);
			
			// Логируем заголовки
			if (response.headers) {
				this.logger.debug(`Заголовки ответа:`);
				Object.keys(response.headers).forEach(key => {
					const value = response.headers[key];
					const valueStr = Array.isArray(value) ? value.join(', ') : String(value);
					const preview = valueStr.length > 200 ? valueStr.substring(0, 200) + '...' : valueStr;
					this.logger.debug(`  ${key}: ${preview}`);
				});
			}
			
			// Логируем тело ответа (первые 500 символов)
			if (response.data) {
				const dataStr = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
				const dataPreview = dataStr.length > 500 ? dataStr.substring(0, 500) + '...' : dataStr;
				this.logger.debug(`Тело ответа (первые 500 символов):\n${dataPreview}`);
			}
			
			// Cookies автоматически сохраняются через interceptor
			if (response.cookies && response.cookies.length > 0) {
				this.logger.log(`✅ Получено cookies при подтверждении: ${response.cookies.length}`);
				response.cookies.forEach((cookie: string, index: number) => {
					const cookieName = cookie.split('=')[0];
					const cookiePreview = cookie.length > 100 ? cookie.substring(0, 100) + '...' : cookie;
					this.logger.debug(`  Cookie ${index + 1}: ${cookieName} (${cookiePreview})`);
				});
			} else {
				this.logger.warn('⚠️ Cookies не получены при подтверждении авторизации');
			}
			
			if (response.redirectedToAuth) {
				this.logger.warn('⚠️ Ответ перенаправил на страницу авторизации');
			} else {
				this.logger.log('✅ Подтверждение авторизации успешно');
			}
			
			this.logger.log(`=== Конец ответа на подтверждение авторизации ===`);
			
			return {
				success: response.success,
				status: response.status,
				data: response.data,
				headers: response.headers,
				cookies: response.cookies,
				redirectedToAuth: response.redirectedToAuth,
			};
		} catch (error) {
			this.logger.error(`Ошибка подтверждения авторизации: ${(error as Error).message}`);
			throw error;
		}
	}
	
	/**
	 * Получить страницу заявки
	 * @param {string} applicationId - ID заявки
	 * @returns {Promise<any>} HTML страницы заявки
	 */
	async getApplicationPage(applicationId: string) {
		this.logger.log(`Получение страницы заявки ${applicationId}...`);
		
		const result = await this.request({
			url: `/ru/myapp/actionShowApp/${applicationId}`,
			method: 'GET',
		});
		
		console.log(result,'result!')
		return {
			success: result.success,
			status: result.status,
			html: typeof result.data === 'string' ? result.data : JSON.stringify(result.data),
			headers: result.headers,
			redirectedToAuth: result.redirectedToAuth,
		};
	}

	/**
	 * Удалить заявку
	 * @param {string} applicationId - ID заявки для удаления
	 * @returns {Promise<any>} Результат удаления
	 */
	async deleteApplication(applicationId: string): Promise<any> {
		this.logger.log(`Удаление заявки ${applicationId}...`);
		
		try {
			const result = await this.request({
				url: `/ru/myapp`,
				method: 'GET',
				params: {
					org_name: '',
					trd_method: '',
					trd_status: '',
					buy_numb: '',
					buy_name: '',
					app_numb: '',
					app_status: '',
					start_date: '',
					end_date: '',
					prc_status: '',
					address: '',
					amount_start: '',
					amount_end: '',
					appid: applicationId,
					btn: 'appdel',
				},
				additionalHeaders: {
					'Referer': `https://v3bl.goszakup.gov.kz/ru/myapp`,
				}
			});
			
			this.logger.log(`Заявка ${applicationId} удалена. Статус: ${result.status}`);
			return {
				success: result.success,
				status: result.status,
				data: result.data,
			};
		} catch (error) {
			this.logger.error(`Ошибка удаления заявки ${applicationId}: ${(error as Error).message}`);
			throw error;
		}
	}
	
	
	/**
	 * Извлечь номер заявки из HTML
	 * @param {string} html - HTML содержимое страницы
	 * @returns {string | null} Номер заявки или null, если не найден
	 */
	extractApplicationNumber(html: string): string | null {
		try {
			// Ищем "Номер заявки" в HTML
			// На основе реального HTML страницы:
			// 1. <label class="col-sm-3 control-label">Номер заявки</label><div class="col-sm-9"><input type='text' class="form-control" value="67519020" readonly />
			// 2. <h4>Просмотр заявки №67519020</h4>
			
			const patterns = [
				// Вариант 1: В input поле после label "Номер заявки"
				// <label[^>]*>Номер\s+заявки<\/label>[\s\S]{0,500}?<input[^>]*value\s*=\s*["']([0-9]+)["']
				/<label[^>]*>Номер\s+заявки<\/label>[\s\S]{0,500}?<input[^>]*value\s*=\s*["']([0-9]+)["']/i,
				
				// Вариант 2: В заголовке "Просмотр заявки №123456"
				/Просмотр\s+заявки\s*№\s*([0-9]+)/i,
				
				// Вариант 3: В заголовке h4 с номером
				/<h4[^>]*>Просмотр\s+заявки\s*№\s*([0-9]+)/i,
				
				// Вариант 4: После label "Номер заявки" в следующем input
				/Номер\s+заявки[\s\S]{0,300}?<input[^>]*value\s*=\s*["']([0-9]+)["']/i,
				
				// Вариант 5: В value атрибуте input после "Номер заявки"
				/Номер\s+заявки[^>]*>[\s\S]{0,200}?value\s*=\s*["']([0-9]+)["']/i,
				
				// Вариант 6: Общий поиск после "Номер заявки"
				/Номер\s+заявки[^0-9]*([0-9]{6,})/i,
			];
			
			for (const pattern of patterns) {
				const match = html.match(pattern);
				if (match && match[1]) {
					const number = match[1].trim();
					if (number && /^[0-9]+$/.test(number)) {
						this.logger.log(`Номер заявки найден: ${number}`);
						return number;
					}
				}
			}
			
			this.logger.warn('Номер заявки не найден в HTML');
			this.logger.debug('Попытка найти номер заявки в заголовке или других местах...');
			
			// Дополнительная попытка: ищем любые числа после "заявки"
			const fallbackPattern = /заявки[^0-9]*([0-9]{6,})/i;
			const fallbackMatch = html.match(fallbackPattern);
			if (fallbackMatch && fallbackMatch[1]) {
				const number = fallbackMatch[1].trim();
				this.logger.log(`Номер заявки найден (fallback): ${number}`);
				return number;
			}
			
			return null;
		} catch (error) {
			this.logger.error(`Ошибка извлечения номера заявки: ${error.message}`);
			return null;
		}
	}
	
	/**
	 * Выход из системы
	 */
	async logout() {
		try {
			this.logger.log('Выход из системы...');
			const response = await this.httpService.post('/logout');
			
			return {
				success: response.status === 200,
				status: response.status,
				data: response.data,
			};
		} catch (error) {
			this.logger.error(`Ошибка выхода: ${error.message}`);
			throw error;
		}
	}
	
	
	
	/**
	 * Универсальный метод для отправки запросов к порталу
	 * Автоматически добавляет заголовки и обрабатывает редиректы
	 * @param config - Конфигурация запроса
	 * @returns {Promise<any>} Результат запроса
	 */
	async request(config: {
		url: string;
		method?: 'GET' | 'POST';
		data?: any;
		params?: any;
		isFormData?: boolean;
		referer?: string;
		additionalHeaders?: Record<string, string>;
		timeout?: number;
	}): Promise<any> {
		try {
			const {
				url,
				method = 'GET',
				data = {},
				params = {},
				isFormData = false,
				referer,
				additionalHeaders = {},
				timeout
			} = config;
			
			// Проверяем, что url является строкой
			if (typeof url !== 'string') {
				this.logger.error(`КРИТИЧЕСКАЯ ОШИБКА: url не является строкой! Тип: ${typeof url}, значение: ${JSON.stringify(url)}`);
				throw new Error(`url должен быть строкой, получен: ${typeof url}, значение: ${JSON.stringify(url)}`);
			}
			
			// Проверяем, что url не содержит [object Object]
			if (url.includes('[object Object]')) {
				this.logger.error(`КРИТИЧЕСКАЯ ОШИБКА: url содержит [object Object]! URL: ${url}`);
				throw new Error(`url содержит [object Object]: ${url}`);
			}
			
			const baseURL = this.configService.get<string>('PORTAL_BASE_URL', 'https://v3bl.goszakup.gov.kz');
			const fullReferer = referer || (url.startsWith('http') ? url : `${baseURL}${url}`);
			
			const headers = this.getStandardHeaders(fullReferer, additionalHeaders, url, method, isFormData);
			
			this.logger.debug(`Выполнение ${method} запроса на ${url} (тип: ${typeof url})`);
			
			let response;
			const requestConfig: any = {
				headers,
				params,
				maxRedirects: 5,
				validateStatus: (status: number) => status < 500,
			};
			if (timeout != null) {
				requestConfig.timeout = timeout;
			}
			
			if (method === 'GET') {
				// Определяем, нужно ли кэшировать этот запрос
				// Не кэшируем AJAX запросы (ajax_*), так как они могут возвращать JSON
				const isAjaxRequest = url.includes('/ajax_');
				// const shouldCache = this.enableHtmlCache && !isAjaxRequest;
				const shouldCache = false
				
				// Кэширование GET запросов для ускорения (только не-AJAX)
				if (shouldCache) {
					const cacheKey = this.getCacheKey(url, params);
					const cachedResponse = await this.redisService.get(cacheKey);
					if (cachedResponse) {
						this.logger.debug(`Получен кэшированный ответ для ${url}`);
						return JSON.parse(cachedResponse);
					}
				}
				
				response = await this.httpService.get(url, requestConfig);
				
				// Кэшируем успешные GET запросы (только HTML страницы, не AJAX)
				if (shouldCache && response.status === 200 && response.data) {
					// Проверяем Content-Type - кэшируем только HTML
					const contentType = response.headers['content-type'] || '';
					const isHtml = contentType.includes('text/html') || 
					              (typeof response.data === 'string' && response.data.includes('<!DOCTYPE') || response.data.includes('<html'));
					
					if (isHtml) {
						const cacheKey = this.getCacheKey(url, params);
						const cacheData = {
							status: response.status,
							data: response.data,
							headers: response.headers,
						};
						await this.redisService.set(cacheKey, JSON.stringify(cacheData), this.htmlCacheTtl);
						this.logger.debug(`Ответ закэширован для ${url}`);
					}
				}
			} else {
				if (isFormData) {
					response = await this.httpService.postFormData(url, data, requestConfig);
				} else {
					// Если это POST Form (application/x-www-form-urlencoded), используем postForm
					// Если JSON, то обычный post. Определим по заголовкам или по умолчанию
					if (headers['Content-Type'] === 'application/json') {
						response = await this.httpService.post(url, data, requestConfig);
					} else {
						// По умолчанию для портала используем form-urlencoded для обычных POST запросов (как postForm)
						// Если нужно отправить JSON, нужно явно передать заголовок Content-Type: application/json
						response = await this.httpService.postForm(url, data, requestConfig);
					}
				}
			}
			
			// Проверяем, не перенаправило ли нас на страницу авторизации
			let redirectedToAuth = false;
			if (response.status === 302 || response.status === 301) {
				const location = response.headers.location || '';
				
				if (location.includes('/user/auth') || location.includes('/login')) {
					redirectedToAuth = true;
					this.logger.warn(`⚠️  Запрос перенаправил на страницу авторизации: ${location}`);
				}
			}
			
			// else if (typeof response.data === 'string') {
			// 	if (response.data.includes('/user/auth') || response.data.includes('/login') || (response.data.includes('Вход в систему') && !url.includes('auth'))) {
			// 		redirectedToAuth = true;
			// 		this.logger.warn('⚠️  Ответ содержит страницу авторизации');
			// 	}
			// }
			
			// Cookies автоматически сохраняются через interceptor
			const setCookieHeaders = response.headers['set-cookie'] || [];
			
			return {
				success: (response.status === 200 || response.status === 302 || response.status === 201) && !redirectedToAuth,
				status: response.status,
				data: response.data,
				headers: this.sanitizeHeaders(response.headers),
				cookies: setCookieHeaders,
				redirectedToAuth: redirectedToAuth,
			};
		} catch (error) {
			this.logger.error(`Ошибка запроса ${config.method} ${config.url}: ${(error as Error).message}`);
			if ((error as any).response) {
				this.logger.error(`Статус ответа: ${(error as any).response.status}`);
				return {
					success: false,
					status: (error as any).response.status,
					error: (error as any).response.data,
					redirectedToAuth: false,
				};
			}
			throw error;
		}
	}
	
	/**
	 * Получить стандартные заголовки для запросов к порталу
	 * @param referer - URL реферера (опционально)
	 * @param additionalHeaders - Дополнительные заголовки (опционально)
	 * @param url - URL запроса (для определения типа - AJAX или обычный)
	 * @param method - HTTP метод (для определения типа запроса)
	 * @param isFormData - Является ли запрос form data
	 * @returns Объект с заголовками
	 * @private
	 */
	private getStandardHeaders(
		referer?: string,
		additionalHeaders: Record<string, string> = {},
		url?: string,
		method: string = 'GET',
		isFormData: boolean = false
	): Record<string, string> {
		const baseURL = this.configService.get<string>('PORTAL_BASE_URL', 'https://v3bl.goszakup.gov.kz');
		const userAgent = this.configService.get<string>(
			'USER_AGENT',
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
		);
		
		// Определяем версию Chrome из User-Agent для sec-ch-ua заголовков
		const chromeVersionMatch = userAgent.match(/Chrome\/(\d+)/);
		const chromeVersion = chromeVersionMatch ? chromeVersionMatch[1] : '140';
		
		// Определяем, является ли запрос AJAX (по наличию ajax_ в URL)
		const isAjaxRequest = url?.includes('/ajax_') || false;
		
		// Базовые заголовки
		const standardHeaders: Record<string, string> = {
			'User-Agent': userAgent,
			'Accept-Encoding': 'gzip, deflate, br, zstd',
			'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
			'Origin': baseURL,
			'Sec-GPC': '1',
			'sec-ch-ua': `"Chromium";v="${chromeVersion}", "Not=A?Brand";v="24", "Brave";v="${chromeVersion}"`,
			'sec-ch-ua-mobile': '?0',
			'sec-ch-ua-platform': '"macOS"',
			...additionalHeaders,
		};
		
		// Заголовки для AJAX запросов
		if (isAjaxRequest) {
			standardHeaders['Accept'] = 'application/json, text/javascript, */*; q=0.01';
			standardHeaders['Sec-Fetch-Dest'] = 'empty';
			standardHeaders['Sec-Fetch-Mode'] = 'cors';
			standardHeaders['Sec-Fetch-Site'] = 'same-origin';
			standardHeaders['X-Requested-With'] = 'XMLHttpRequest';
			
			// Для form data в AJAX запросах устанавливаем Content-Type
			if (isFormData && method === 'POST') {
				standardHeaders['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
			}
		} else {
			// Заголовки для обычных запросов (HTML страницы)
			standardHeaders['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
			standardHeaders['Sec-Fetch-Dest'] = 'document';
			standardHeaders['Sec-Fetch-Mode'] = 'navigate';
			standardHeaders['Sec-Fetch-Site'] = 'same-origin';
			standardHeaders['Sec-Fetch-User'] = '?1';
			standardHeaders['Upgrade-Insecure-Requests'] = '1';
			standardHeaders['Cache-Control'] = 'max-age=0';
		}
		
		if (referer) {
			standardHeaders['Referer'] = referer;
		}
		
		return standardHeaders;
	}
	
	/**
	 * Преобразовать headers в простой объект (для избежания проблем с типами)
	 * @private
	 */
	private sanitizeHeaders(headers: any): Record<string, any> {
		if (!headers) {
			return {};
		}
		
		// Преобразуем headers в простой объект
		const sanitized: Record<string, any> = {};
		for (const [key, value] of Object.entries(headers)) {
			sanitized[key] = value;
		}
		return sanitized;
	}
	
	/**
	 * Извлечь ключ из ответа
	 * @private
	 */
	private extractKeyFromResponse(response: any): string | null {
		try {
			// Если ответ - строка (текст)
			if (typeof response.data === 'string') {
				// Пытаемся найти ключ в тексте (32 символа hex)
				const keyMatch = response.data.match(/[a-f0-9]{32}/i);
				if (keyMatch) {
					return keyMatch[0];
				}
				// Или просто возвращаем весь текст, если он короткий (вероятно это ключ)
				if (response.data.length <= 64 && /^[a-f0-9]+$/i.test(response.data.trim())) {
					return response.data.trim();
				}
			}
			
			// Если ответ - JSON
			if (typeof response.data === 'object') {
				return response.data.key || response.data.data || response.data.token;
			}
			
			return null;
		} catch (error) {
			this.logger.error(`Ошибка извлечения ключа: ${error.message}`);
			return null;
		}
	}
	
	/**
	 * Генерация ключа кэша для URL и параметров
	 */
	private getCacheKey(url: string, params: any): string {
		const paramsStr = JSON.stringify(params || {});
		const key = `${url}:${paramsStr}`;
		const hash = crypto.createHash('sha256').update(key).digest('hex');
		return `${this.htmlCacheKeyPrefix}${hash}`;
	}
	
	/**
	 * Очистить кэш для конкретного URL
	 */
	async clearCache(url: string, params?: any): Promise<void> {
		if (this.enableHtmlCache) {
			const cacheKey = this.getCacheKey(url, params || {});
			await this.redisService.delete(cacheKey);
			this.logger.debug(`Кэш очищен для ${url}`);
		}
	}
}

