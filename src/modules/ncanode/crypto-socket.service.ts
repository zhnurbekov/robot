import {Injectable, Logger, OnModuleInit, OnModuleDestroy} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {WebSocket} from 'ws';
import * as https from 'https';

/**
 * Сервис для подключения к crypto socket через WebSocket Secure (WSS)
 *
 * Подключается к crypto socket по адресу wss://127.0.0.1:6127/tumarcsp/
 *
 * Пример использования:
 * ```typescript
 * constructor(private cryptoSocketService: CryptoSocketService) {}
 *
 * async someMethod() {
 *   // Отправка сообщения и ожидание ответа
 *   const response = await this.cryptoSocketService.sendMessage({
 *     method: 'someMethod',
 *     params: {...}
 *   });
 * }
 * ```
 *
 * Конфигурация через переменные окружения:
 * - CRYPTO_SOCKET_HOST - хост (по умолчанию: 127.0.0.1)
 * - CRYPTO_SOCKET_PORT - порт (по умолчанию: 6127)
 * - CRYPTO_SOCKET_PATH - путь (по умолчанию: /tumarcsp/)
 * - CRYPTO_SOCKET_RECONNECT_INTERVAL - интервал переподключения в мс (по умолчанию: 5000)
 * - CRYPTO_SOCKET_MAX_RECONNECT_ATTEMPTS - максимальное количество попыток (по умолчанию: 10)
 */
@Injectable()
export class CryptoSocketService implements OnModuleInit, OnModuleDestroy {
	private readonly logger = new Logger(CryptoSocketService.name);
	private wsClient: WebSocket | null = null;
	private readonly socketUrl: string;
	private readonly reconnectInterval: number;
	private readonly maxReconnectAttempts: number;
	private reconnectAttempts: number = 0;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private isConnecting: boolean = false;
	private messageQueue: Array<{ data: any; resolve: (value: any) => void; reject: (error: Error) => void }> = [];
	private messageIdCounter: number = 0;
	private pendingMessages: Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }> = new Map();
	// Очередь ожидающих ответов для протокола без ID (сопоставление по Function)
	private pendingRequests: Array<{ functionName: string; resolve: (value: any) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }> = [];
	// Callback для обработки результата EncryptOfferPrice
	private encryptOfferPriceCallback: ((response: any, context?: any) => Promise<void>) | null = null;
	// Контекст для текущего запроса EncryptOfferPrice
	private encryptOfferPriceContext: any = null;
	
	constructor(private configService: ConfigService) {
		const host = this.configService.get<string>('CRYPTO_SOCKET_HOST', '127.0.0.1');
		const port = this.configService.get<number>('CRYPTO_SOCKET_PORT', 6127);
		const path = this.configService.get<string>('CRYPTO_SOCKET_PATH', '/tumarcsp/');
		this.socketUrl = `wss://${host}:${port}${path}`;
		this.reconnectInterval = this.configService.get<number>('CRYPTO_SOCKET_RECONNECT_INTERVAL', 5000);
		this.maxReconnectAttempts = this.configService.get<number>('CRYPTO_SOCKET_MAX_RECONNECT_ATTEMPTS', 10);
	}
	
	onModuleInit() {
		this.logger.log('Инициализация crypto socket сервиса...');
		// Подключение теперь запускается лениво при первом запросе (см. sendMessage/sendTumarCSPRequest)
	}
	
	onModuleDestroy() {
		this.logger.log('Остановка crypto socket сервиса...');
		this.disconnect();
	}
	
	/**
	 * Подключение к crypto socket
	 */
	public connect(): void {
		if (this.isConnecting || (this.wsClient && this.wsClient.readyState === WebSocket.OPEN)) {
			this.logger.debug('Уже подключен или подключение в процессе');
			return;
		}
		
		this.isConnecting = true;
		this.logger.log(`Подключение к crypto socket: ${this.socketUrl}`);
		try {
			// Создаем WebSocket клиент с поддержкой WSS
			// Добавляем заголовки, как в браузере
			const origin =
				this.configService.get<string>('CRYPTO_SOCKET_ORIGIN') ||
				this.configService.get<string>('PORTAL_BASE_URL', 'https://v3bl.goszakup.gov.kz');
			const userAgent = this.configService.get<string>(
				'USER_AGENT',
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
			);
			
			const headers: Record<string, string> = {
				'User-Agent': userAgent,
				'Origin': origin,
				'Accept-Encoding': 'gzip, deflate, br, zstd',
				'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
				'Pragma': 'no-cache',
				'Cache-Control': 'no-cache',
				'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits',
			};
			
			this.wsClient = new WebSocket(this.socketUrl, {
				rejectUnauthorized: false, // Для самоподписанных сертификатов
				agent: new https.Agent({
					rejectUnauthorized: false,
				}),
				headers: headers,
			});
			
			this.logger.debug(`WebSocket заголовки: ${JSON.stringify(headers)}`);
			this.setupEventHandlers();
		} catch (error) {
			this.logger.error(`Ошибка создания WebSocket соединения: ${(error as Error).message}`);
			this.isConnecting = false;
			this.scheduleReconnect();
		}
	}
	
	/**
	 * Настройка обработчиков событий WebSocket
	 */
	private setupEventHandlers(): void {
		if (!this.wsClient) {
			return;
		}
		
		this.wsClient.on('open', async () => {
			this.logger.log('✅ Подключение к crypto socket установлено');
			this.logger.debug(`WebSocket readyState: ${this.wsClient?.readyState}`);
			this.logger.debug(`WebSocket protocol: ${this.wsClient?.protocol}`);
			this.logger.debug(`WebSocket extensions: ${this.wsClient?.extensions}`);
			this.isConnecting = false;
			this.reconnectAttempts = 0;
			
			// Устанавливаем API ключ после подключения (обязательно для инициализации TumSocket)
			// Очередь сообщений обрабатывается при явных вызовах (setPrice и др.)
			// Добавляем небольшую задержку перед обработкой очереди
			await new Promise(resolve => setTimeout(resolve, 100));
			this.processMessageQueue();
		});
		
		this.wsClient.on('message', (data: Buffer | string) => {
			try {
				const message = typeof data === 'string' ? data : data.toString('utf8');
				this.logger.log(`📨 Получено сообщение от crypto socket (${message.length} байт)`);
				this.logger.debug(`Полное сообщение: ${message}`);
				this.handleMessage(message);
			} catch (error) {
				this.logger.error(`Ошибка обработки сообщения: ${(error as Error).message}`);
				this.logger.error(`Stack: ${(error as Error).stack}`);
			}
		});
		
		this.wsClient.on('error', (error: Error) => {
			this.logger.error(`❌ Ошибка WebSocket: ${error.message}`);
			this.logger.error(`Stack: ${(error as any).stack || 'нет stack trace'}`);
			this.logger.error(`Код ошибки: ${(error as any).code || 'неизвестно'}`);
			this.isConnecting = false;
		});
		
		this.wsClient.on('close', (code: number, reason: Buffer) => {
			this.logger.log(`WebSocket соединение закрыто. Код: ${code}, Причина: ${reason.toString()}`);
			this.isConnecting = false;
			this.wsClient = null;
			
			// Отклоняем все ожидающие сообщения
			this.rejectPendingMessages(new Error('Соединение закрыто'));
			
			// Планируем переподключение, если не было нормального закрытия
			if (code !== 1000) {
				this.scheduleReconnect();
			}
		});
		
		this.wsClient.on('ping', () => {
			this.logger.debug('Получен ping от сервера');
			if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
				this.wsClient.pong();
			}
		});
		
		this.wsClient.on('pong', () => {
			this.logger.debug('Получен pong от сервера');
		});
		
		this.wsClient.on('unexpected-response', (request, response) => {
			this.logger.error(`Неожиданный ответ от сервера: ${response.statusCode} ${response.statusMessage}`);
			this.logger.error(`Заголовки ответа: ${JSON.stringify(response.headers)}`);
		});
	}
	
	/**
	 * Обработка входящих сообщений
	 */
	private handleMessage(message: string): void {
		try {
			let parsed: any;
			try {
				parsed = JSON.parse(message);
			} catch {
				// Если не JSON, обрабатываем как текстовое сообщение
				this.logger.debug(`Получено текстовое сообщение: ${message}`);
				return;
			}
			
			// Если есть ID сообщения, находим соответствующий pending запрос
			if (parsed.id !== undefined && this.pendingMessages.has(parsed.id)) {
				const pending = this.pendingMessages.get(parsed.id);
				if (pending) {
					clearTimeout(pending.timeout);
					this.pendingMessages.delete(parsed.id);
					pending.resolve(parsed);
				}
			} else {
				// Сообщение без ID - возможно, это ответ TumarCSP
				this.logger.log(`📥 Получен ответ без ID. Полный ответ: ${JSON.stringify(parsed)}`);
				this.logger.debug(`Ожидающих запросов: ${this.pendingRequests.length}`);
				
				// Пытаемся найти соответствующий запрос по Function
				if (parsed.Function && this.pendingRequests.length > 0) {
					const functionName = parsed.Function;
					this.logger.debug(`Поиск запроса для функции: ${functionName}`);
					this.logger.debug(`Ожидающие функции: ${this.pendingRequests.map(r => r.functionName).join(', ')}`);
					
					const index = this.pendingRequests.findIndex(req => req.functionName === functionName);
					
					if (index !== -1) {
						const pending = this.pendingRequests[index];
						this.pendingRequests.splice(index, 1);
						clearTimeout(pending.timeout);
						this.logger.log(`✅ Получен ответ на запрос: ${functionName}`);
						
						// Проверяем, является ли это результатом EncryptOfferPrice
						if (functionName === 'EncryptOfferPrice' && parsed.result === 'true' && parsed.encryptData && parsed.encryptKey) {
							this.logger.log('📝 Обнаружен результат EncryptOfferPrice, вызываем callback для обработки...');
							if (this.encryptOfferPriceCallback) {
								// Вызываем callback асинхронно, не блокируя разрешение промиса
								const context = this.encryptOfferPriceContext;
								this.encryptOfferPriceContext = null; // Очищаем контекст после использования
								this.encryptOfferPriceCallback(parsed, context).catch((error) => {
									this.logger.error(`Ошибка в callback обработки EncryptOfferPrice: ${(error as Error).message}`);
								});
							} else {
								this.logger.warn('⚠️  Callback для обработки EncryptOfferPrice не зарегистрирован');
							}
						}
						
						pending.resolve(parsed);
						return;
					} else {
						this.logger.warn(`⚠️  Не найден ожидающий запрос для функции: ${functionName}`);
					}
				}
				
				// Если не нашли по Function, но есть ожидающие запросы - берем первый (FIFO)
				if (this.pendingRequests.length > 0) {
					this.logger.debug('Ответ без Function, но есть ожидающие запросы. Обрабатываем как ответ на первый запрос (FIFO)');
					const firstPending = this.pendingRequests.shift();
					if (firstPending) {
						clearTimeout(firstPending.timeout);
						this.logger.log(`✅ Обработан ответ как ответ на запрос: ${firstPending.functionName}`);
						firstPending.resolve(parsed);
						return;
					}
				}
				
				// Если не нашли соответствующий запрос, логируем
				this.logger.warn(`⚠️  Получено сообщение без ID и без соответствующего запроса: ${JSON.stringify(parsed).substring(0, 300)}...`);
				
				// Если это ответ TumarCSP (содержит Function или TumarCSP), логируем
				if (parsed.TumarCSP || parsed.Function) {
					this.logger.log(`Получен ответ TumarCSP: ${parsed.Function || 'unknown'} (не найден соответствующий запрос)`);
					
					// Проверяем, является ли это результатом EncryptOfferPrice
					if (parsed.Function === 'EncryptOfferPrice' && parsed.result === 'true' && parsed.encryptData && parsed.encryptKey) {
						this.logger.log('📝 Обнаружен результат EncryptOfferPrice, вызываем callback для обработки...');
						if (this.encryptOfferPriceCallback) {
							// Вызываем callback асинхронно, не блокируя обработку сообщения
							const context = this.encryptOfferPriceContext;
							this.encryptOfferPriceContext = null; // Очищаем контекст после использования
							this.encryptOfferPriceCallback(parsed, context).catch((error) => {
								this.logger.error(`Ошибка в callback обработки EncryptOfferPrice: ${(error as Error).message}`);
							});
						} else {
							this.logger.warn('⚠️  Callback для обработки EncryptOfferPrice не зарегистрирован');
						}
					}
				}
			}
		} catch (error) {
			this.logger.error(`Ошибка парсинга сообщения: ${(error as Error).message}`);
		}
	}
	
	/**
	 * Регистрация callback для обработки результата EncryptOfferPrice
	 * @param callback - Функция для обработки результата шифрования цены
	 */
	setEncryptOfferPriceCallback(callback: (response: any, context?: any) => Promise<void>): void {
		this.encryptOfferPriceCallback = callback;
		this.logger.log('✅ Callback для обработки EncryptOfferPrice зарегистрирован');
	}
	
	/**
	 * Установка контекста для следующего запроса EncryptOfferPrice
	 * @param context - Контекст с announceId, applicationId, buyLotPointId и т.д.
	 */
	setEncryptOfferPriceContext(context: any): void {
		this.encryptOfferPriceContext = context;
		this.logger.debug(`Контекст для EncryptOfferPrice установлен: ${JSON.stringify(context)}`);
	}
	
	/**
	 * Удаление callback для обработки результата EncryptOfferPrice
	 */
	removeEncryptOfferPriceCallback(): void {
		this.encryptOfferPriceCallback = null;
		this.logger.log('🗑️  Callback для обработки EncryptOfferPrice удален');
	}
	
	
	
	
	/**
	 * Отправка сообщения через crypto socket
	 * @param data - Данные для отправки
	 * @param timeout - Таймаут ожидания ответа (мс)
	 * @param addId - Добавлять ли ID к сообщению (по умолчанию true)
	 * @returns Promise с ответом от сервера
	 */
	async sendMessage(data: any, timeout: number = 30000): Promise<any> {
		return new Promise((resolve, reject) => {
			if (!this.isConnected()) {
				// Если не подключен, добавляем в очередь
				this.messageQueue.push({data, resolve, reject});
				this.logger.debug('Сообщение добавлено в очередь (не подключен)');
				
				// Пытаемся подключиться, если еще не подключены
				if (!this.isConnecting) {
					this.connect();
				}
				return;
			}
			
			// Отправляем сообщение как есть (TumarCSP протокол не требует ID)
			const message = data;
			
			// Определяем имя функции для сопоставления ответа
			const functionName = data.Function || null;
			
			// Если есть имя функции, добавляем в очередь ожидающих ответов
			let timeoutHandle: NodeJS.Timeout | null = null;
			if (functionName) {
				timeoutHandle = setTimeout(() => {
					const index = this.pendingRequests.findIndex(req => req.functionName === functionName);
					if (index !== -1) {
						this.pendingRequests.splice(index, 1);
					}
					reject(new Error(`Таймаут ожидания ответа на ${functionName} (${timeout}мс)`));
				}, timeout);
				
				this.pendingRequests.push({
					functionName,
					resolve,
					reject,
					timeout: timeoutHandle,
				});
				
				this.logger.debug(`Ожидание ответа на функцию: ${functionName}`);
			} else {
				// Если нет имени функции, разрешаем промис сразу
				this.logger.debug('Отправка сообщения без Function - ответ не ожидается');
			}
			
			// Отправляем сообщение
			try {
				const messageStr = JSON.stringify(message);
				this.logger.log(`📤 Отправка сообщения в crypto socket: ${functionName || 'unknown'}`);
				this.logger.log(`Полные данные: ${messageStr}`);
				
				// Проверяем состояние соединения перед отправкой
				if (this.wsClient!.readyState !== WebSocket.OPEN) {
					throw new Error(`WebSocket не открыт. Состояние: ${this.wsClient!.readyState}`);
				}
				
				// Отправляем как текст (не binary)
				this.wsClient!.send(messageStr, (error) => {
					if (error) {
						this.logger.error(`Ошибка отправки сообщения: ${error.message}`);
						if (functionName && timeoutHandle) {
							const index = this.pendingRequests.findIndex(req => req.functionName === functionName);
							if (index !== -1) {
								this.pendingRequests.splice(index, 1);
								clearTimeout(timeoutHandle);
							}
						}
						reject(error);
					} else {
						this.logger.debug(`Сообщение успешно отправлено: ${functionName || 'unknown'}`);
					}
				});
				
				// Если нет имени функции, разрешаем промис сразу
				if (!functionName) {
					resolve({success: true, sent: true});
				}
			} catch (error) {
				if (functionName && timeoutHandle) {
					const index = this.pendingRequests.findIndex(req => req.functionName === functionName);
					if (index !== -1) {
						this.pendingRequests.splice(index, 1);
						clearTimeout(timeoutHandle);
					}
				}
				reject(error);
			}
		});
	}
	
	/**
	 * Обработка очереди сообщений после подключения
	 */
	private processMessageQueue(): void {
		if (this.messageQueue.length === 0) {
			return;
		}
		
		this.logger.log(`Обработка очереди сообщений: ${this.messageQueue.length} сообщений`);
		const queue = [...this.messageQueue];
		this.messageQueue = [];
		
		for (const item of queue) {
			this.sendMessage(item.data)
				.then(item.resolve)
				.catch(item.reject);
		}
	}
	
	/**
	 * Отклонение всех ожидающих сообщений
	 */
	private rejectPendingMessages(error: Error): void {
		for (const [id, pending] of this.pendingMessages.entries()) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.pendingMessages.clear();
		
		// Отклоняем запросы без ID
		for (const pending of this.pendingRequests) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.pendingRequests = [];
		
		// Отклоняем сообщения в очереди
		for (const item of this.messageQueue) {
			item.reject(error);
		}
		this.messageQueue = [];
	}
	
	/**
	 * Планирование переподключения
	 */
	private scheduleReconnect(): void {
		if (this.reconnectTimer) {
			return;
		}
		
		if (this.reconnectAttempts >= this.maxReconnectAttempts) {
			this.logger.error(`Достигнуто максимальное количество попыток переподключения (${this.maxReconnectAttempts})`);
			return;
		}
		
		this.reconnectAttempts++;
		const delay = this.reconnectInterval * this.reconnectAttempts;
		this.logger.log(`Планирование переподключения через ${delay}мс (попытка ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
		
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, delay);
	}
	
	/**
	 * Проверка подключения
	 */
	isConnected(): boolean {
		return this.wsClient !== null && this.wsClient.readyState === WebSocket.OPEN;
	}
	
	/**
	 * Получение состояния подключения
	 */
	getConnectionState(): string {
		if (!this.wsClient) {
			return 'DISCONNECTED';
		}
		
		switch (this.wsClient.readyState) {
			case WebSocket.CONNECTING:
				return 'CONNECTING';
			case WebSocket.OPEN:
				return 'OPEN';
			case WebSocket.CLOSING:
				return 'CLOSING';
			case WebSocket.CLOSED:
				return 'CLOSED';
			default:
				return 'UNKNOWN';
		}
	}
	
	/**
	 * Отключение от crypto socket
	 */
	disconnect(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		
		if (this.wsClient) {
			this.logger.log('Закрытие соединения с crypto socket...');
			this.wsClient.removeAllListeners();
			if (this.wsClient.readyState === WebSocket.OPEN || this.wsClient.readyState === WebSocket.CONNECTING) {
				this.wsClient.close(1000, 'Normal closure');
			}
			this.wsClient = null;
		}
		
		this.rejectPendingMessages(new Error('Сервис остановлен'));
	}
	
	/**
	 * Принудительное переподключение
	 */
	async reconnect(): Promise<void> {
		this.logger.log('Принудительное переподключение...');
		this.disconnect();
		this.reconnectAttempts = 0;
		await new Promise(resolve => setTimeout(resolve, 1000));
		this.connect();
	}
	
	/**
	 * Проверка доступности crypto socket
	 */
	async healthCheck(): Promise<boolean> {
		try {
			if (!this.isConnected()) {
				return false;
			}
			
			// Можно отправить ping или простой запрос для проверки
			// В зависимости от протокола crypto socket
			return true;
		} catch (error) {
			this.logger.error(`Ошибка проверки здоровья: ${(error as Error).message}`);
			return false;
		}
	}
	
	/**
	 * Отправка запроса к TumarCSP API
	 * @param functionName - Имя функции (например, "SetAPIKey")
	 * @param params - Параметры функции
	 * @param apiType - Тип API: 'SYSAPI' (по умолчанию) или 'EFCAPI'
	 * @param timeout - Таймаут ожидания ответа (мс)
	 * @returns Promise с ответом от сервера
	 */
	async sendTumarCSPRequest(functionName: string, params: any, apiType: string = 'SYSAPI', timeout: number = 30000): Promise<any> {
		const requestData = {
			TumarCSP: apiType,
			Function: functionName,
			Param: params,
		};
		
		this.logger.log(`Отправка TumarCSP запроса: ${functionName} (${apiType})`);
		this.logger.debug(`Параметры: ${JSON.stringify(params).substring(0, 200)}...`);
		
		// TumarCSP протокол не требует добавления ID, отправляем как есть
		return this.sendMessage(requestData, timeout);
	}
	
	/**
	 * Установка API ключа
	 * @param apiKey - API ключ для установки
	 * @returns Promise с результатом установки
	 *
	 * Пример использования:
	 * ```typescript
	 * const response = await cryptoSocketService.setAPIKey('your-api-key');
	 * ```
	 */
	async setAPIKey(apiKey: string): Promise<any> {
		return this.sendTumarCSPRequest('SetAPIKey', {apiKey});
	}
	
	/**
	 * Шифрование предложенной цены (EncryptOfferPrice)
	 * @param params - Параметры для шифрования цены
	 * @param params.pl_sum - Плановая сумма
	 * @param params.d_sum - Демпинговая сумма
	 * @param params.d_messageUp - Сообщение при превышении плановой суммы
	 * @param params.d_messageDown - Сообщение при значении меньше демпинговой суммы
	 * @param params.id_priceoffer - ID предложения цены
	 * @param params.public_key - Публичный ключ
	 * @param params.sign - Подпись
	 * @param params.salt - Соль
	 * @returns Promise с результатом шифрования
	 *
	 * Пример использования:
	 * ```typescript
	 * const response = await cryptoSocketService.encryptOfferPrice({
	 *   pl_sum: 15468058,
	 *   d_sum: 13921252.2,
	 *   d_messageUp: "Введенное значение превышает плановую сумму 15468058 тнг",
	 *   d_messageDown: "Введенное значение меньше демпинговой сумму 13921252.2 тнг",
	 *   id_priceoffer: "216194_38204603",
	 *   public_key: "MIICoDCCAgigAwIBAgIUI9E+ON41RJf4QjcblMviIlJ5P0YwDgYKKoMOAwoBAQIDAgUAMCgxCzAJBgNVBAMTAkNBMQwwCgYDVQQKEwNFRkMxCzAJBgNVBAYTAktaMB4XDTI1MTEyNDEwNDc0MloXDTI2MTEyNDEwNTI0MlowNjELMAkGA1UEBhMCS1oxDDAKBgNVBAoTA0VDQzEZMBcGA1UEAxMQMTU3NDYyNTRfODY3Nzc4NzCBrDAjBgkqgw4DCgEEAQIwFgYKKoMOAwoBBAECAQYIKoMOAwoBAwMDgYQABIGAI/uVYpvRkQDvLalHe96Hl6tPNKAPDtiDACkHHDxow4VXMkpREy7NWMl4aWIDWw218PWAOrXOfRoM5uwzl8mnRq577/qCDUcR/AzE8uNxYf4TJH1I+GGdRkh31SeJ27tivdpbUowQRMNbMoyQSWgMFzDK54d0WNlGGh4d5BmqFj+jgakwgaYwCwYDVR0PBAQDAgQwMBMGA1UdJQQMMAoGCCsGAQUFBwMEMB0GA1UdDgQWBBQj0T443jVEl/hCNxuUy+IiUnk/RjBjBgNVHSMEXDBagBTBgoWpCUaaUanAqAfiMZQKTtxVeaEspCowKDELMAkGA1UEAxMCQ0ExDDAKBgNVBAoTA0VGQzELMAkGA1UEBhMCS1qCFEGChakJRppRqcCoB+IxlApO3FV5MA4GCiqDDgMKAQECAwIFAAOBgQBizCUvAkbNlFJndkYrP6OZOJPMuZ2p9JU6HpHGoWSVfULL2sc1uIwzjfIvqYMyHlobHwO5hRdmTioQJ+1v8uzKDagtN4GcXk7rFtP7DGX4NWNneqeuHB0+wsgTwIif8vwPPYNTekYK9T4rL/PF+RAw8Ee/KTW7/8gly+yU0/88Mw==",
	 *   sign: "v/FWJgoIP8VsvD/lC97o4dFhYiA2DAXk5G8m7xu3FQY=",
	 *   salt: "E/4jwfQ9XhdfW4l844xDVg=="
	 * });
	 * ```
	 */
	async encryptOfferPrice(params: {
		pl_sum: number;
		d_sum: number;
		d_messageUp: string;
		d_messageDown: string;
		id_priceoffer: string;
		public_key: string;
		sign: string;
		salt: string;
	}): Promise<any> {
		return this.sendTumarCSPRequest('EncryptOfferPrice', params, 'EFCAPI');
	}
	
	/**
	 * Тестовый вызов encryptOfferPrice с данными по умолчанию
	 * @private
	 */
	private async testEncryptOfferPrice(): Promise<void> {
		try {
			this.logger.log('Тестовый вызов encryptOfferPrice...');
			const result = await this.encryptOfferPrice({
				pl_sum: 15468058,
				d_sum: 13921252.2,
				d_messageUp: "Введенное значение превышает плановую сумму 15468058 тнг",
				d_messageDown: "Введенное значение меньше демпинговой сумму 13921252.2 тнг",
				id_priceoffer: "216194_38204603",
				public_key: "MIICoDCCAgigAwIBAgIUI9E+ON41RJf4QjcblMviIlJ5P0YwDgYKKoMOAwoBAQIDAgUAMCgxCzAJBgNVBAMTAkNBMQwwCgYDVQQKEwNFRkMxCzAJBgNVBAYTAktaMB4XDTI1MTEyNDEwNDc0MloXDTI2MTEyNDEwNTI0MlowNjELMAkGA1UEBhMCS1oxDDAKBgNVBAoTA0VDQzEZMBcGA1UEAxMQMTU3NDYyNTRfODY3Nzc4NzCBrDAjBgkqgw4DCgEEAQIwFgYKKoMOAwoBBAECAQYIKoMOAwoBAwMDgYQABIGAI/uVYpvRkQDvLalHe96Hl6tPNKAPDtiDACkHHDxow4VXMkpREy7NWMl4aWIDWw218PWAOrXOfRoM5uwzl8mnRq577/qCDUcR/AzE8uNxYf4TJH1I+GGdRkh31SeJ27tivdpbUowQRMNbMoyQSWgMFzDK54d0WNlGGh4d5BmqFj+jgakwgaYwCwYDVR0PBAQDAgQwMBMGA1UdJQQMMAoGCCsGAQUFBwMEMB0GA1UdDgQWBBQj0T443jVEl/hCNxuUy+IiUnk/RjBjBgNVHSMEXDBagBTBgoWpCUaaUanAqAfiMZQKTtxVeaEspCowKDELMAkGA1UEAxMCQ0ExDDAKBgNVBAoTA0VGQzELMAkGA1UEBhMCS1qCFEGChakJRppRqcCoB+IxlApO3FV5MA4GCiqDDgMKAQECAwIFAAOBgQBizCUvAkbNlFJndkYrP6OZOJPMuZ2p9JU6HpHGoWSVfULL2sc1uIwzjfIvqYMyHlobHwO5hRdmTioQJ+1v8uzKDagtN4GcXk7rFtP7DGX4NWNneqeuHB0+wsgTwIif8vwPPYNTekYK9T4rL/PF+RAw8Ee/KTW7/8gly+yU0/88Mw==",
				sign: "v/FWJgoIP8VsvD/lC97o4dFhYiA2DAXk5G8m7xu3FQY=",
				salt: "E/4jwfQ9XhdfW4l844xDVg==",
			});
			this.logger.log(`✅ encryptOfferPrice выполнен успешно. Результат: ${JSON.stringify(result).substring(0, 300)}...`);
		} catch (error) {
			this.logger.error(`❌ Ошибка при вызове encryptOfferPrice: ${(error as Error).message}`);
			this.logger.error(`Stack: ${(error as Error).stack}`);
		}
	}
	
	/**
	 * Отправка произвольного TumarCSP запроса
	 * @param requestData - Данные запроса в формате TumarCSP
	 * @param timeout - Таймаут ожидания ответа (мс)
	 * @returns Promise с ответом от сервера
	 *
	 * Пример использования:
	 * ```typescript
	 * const response = await cryptoSocketService.sendTumarCSP({
	 *   TumarCSP: "SYSAPI",
	 *   Function: "SetAPIKey",
	 *   Param: {
	 *     apiKey: "AgGCMPGjSqXIKcFKKljtNnwALEcHDp0jDbjXnrRINdgh7C8e6aL28OEIjhl6G0zKsKYEtY2yiLBWoxtvB44qXQLf9hUyMDI2MDY3MDEwMTAxMDEwMVoAAwAAAIvBFK4B0vK//DWGrD6/2p1GkyzIKElzKWMNJdmBeMTTlaxHTIKfgT4J6MK1h682QWxaeh74KezO5rVUng=="
	 *   }
	 * });
	 * ```
	 */
	async sendTumarCSP(requestData: {
		TumarCSP: string;
		Function: string;
		Param: any;
	}, timeout: number = 30000): Promise<any> {
		this.logger.log(`Отправка TumarCSP запроса: ${requestData.Function}`);
		this.logger.debug(`Данные: ${JSON.stringify(requestData).substring(0, 300)}...`);
		
		// TumarCSP протокол не требует добавления ID, отправляем как есть
		return this.sendMessage(requestData, timeout);
	}
}

