import {Injectable, Logger, OnModuleInit, OnModuleDestroy} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {WebSocketServer, WebSocket} from 'ws';
import * as net from 'net';
import * as tls from 'tls';
import * as https from 'https';
import * as fs from 'fs/promises';
import * as path from 'path';
import {NcanodeService} from './ncanode.service';
import axios, {AxiosError} from 'axios';

@Injectable()
export class NcalayerSocketService implements OnModuleInit, OnModuleDestroy {
	private readonly logger = new Logger(NcalayerSocketService.name);
	private socketServer: net.Server | tls.Server | null = null;
	private wsServer: WebSocketServer | null = null;
	private readonly socketPort: number;
	private readonly wsPort: number;
	private readonly baseUrl: string;
	private readonly useHttps: boolean;
	private readonly sslKeyPath: string | null;
	private readonly sslCertPath: string | null;
	
	constructor(
		private configService: ConfigService,
		private ncanodeService: NcanodeService,
	) {
		this.socketPort = this.configService.get<number>('NCALAYER_SOCKET_PORT', 13579);
		this.wsPort = this.configService.get<number>('NCALAYER_WS_PORT', 13580);
		this.baseUrl = this.configService.get<string>('NCANODE_URL', 'http://localhost:14579');
		this.useHttps = this.configService.get<string>('NCALAYER_USE_HTTPS', 'false') === 'true';
		this.sslKeyPath = this.configService.get<string>('NCALAYER_SSL_KEY_PATH', '') || null;
		this.sslCertPath = this.configService.get<string>('NCALAYER_SSL_CERT_PATH', '') || null;
	}
	
	async onModuleInit() {
		this.logger.log('Инициализация сокет-сервера для имитации ncalayer...');
		await this.startSocketServer();
		await this.startWebSocketServer();
	}
	
	onModuleDestroy() {
		this.logger.log('Остановка сокет-серверов...');
		this.stopSocketServer();
		this.stopWebSocketServer();
	}
	
	/**
	 * Запуск TCP сокет-сервера для имитации ncalayer
	 */
	private async startSocketServer() {
		try {
			const handleConnection = (socket: net.Socket | tls.TLSSocket) => {
				this.logger.log(`Новое ${this.useHttps ? 'TLS' : 'TCP'} подключение от ${socket.remoteAddress}:${socket.remotePort}`);
				
				let buffer = '';
				
				socket.on('data', async (data) => {
					buffer += data.toString();
					
					// Обрабатываем сообщения, разделенные переносами строк или JSON
					const messages = buffer.split('\n').filter(msg => msg.trim());
					buffer = buffer.split('\n').pop() || '';
					
					for (const message of messages) {
						if (message.trim()) {
							await this.handleSocketMessage(socket, message.trim());
						}
					}
				});
				
				socket.on('error', (error) => {
					const err = error as NodeJS.ErrnoException;
					// EPIPE и ECONNRESET - нормальные ошибки при закрытии соединения клиентом
					if (err.code === 'EPIPE' || err.code === 'ECONNRESET') {
						this.logger.debug(`Соединение закрыто клиентом: ${err.code}`);
					} else {
						this.logger.error(`Ошибка сокета: ${err.message} (code: ${err.code})`);
					}
				});
				
				socket.on('close', () => {
					this.logger.log(`${this.useHttps ? 'TLS' : 'TCP'} соединение закрыто: ${socket.remoteAddress}:${socket.remotePort}`);
				});
			};
			
			if (this.useHttps) {
				// Запуск TLS сервера
				const tlsOptions = await this.getTlsOptions();
				if (!tlsOptions) {
					this.logger.warn('Не удалось загрузить SSL сертификаты, запускаем без HTTPS');
					this.socketServer = net.createServer(handleConnection);
				} else {
					this.socketServer = tls.createServer(tlsOptions, handleConnection);
					this.logger.log(`Запуск TLS сокет-сервера с SSL сертификатами`);
				}
			} else {
				// Запуск обычного TCP сервера
				this.socketServer = net.createServer(handleConnection);
			}
			
			this.socketServer.listen(this.socketPort, () => {
				const protocol = this.useHttps ? 'TLS' : 'TCP';
				this.logger.log(`✅ ${protocol} сокет-сервер ncalayer запущен на порту ${this.socketPort}`);
			});
			
			this.socketServer.on('error', (error) => {
				this.logger.error(`Ошибка запуска сокет-сервера: ${error.message}`);
			});
		} catch (error) {
			this.logger.error(`Ошибка создания сокет-сервера: ${(error as Error).message}`);
		}
	}
	
	/**
	 * Получение опций TLS для безопасного соединения
	 */
	private async getTlsOptions(): Promise<tls.TlsOptions | null> {
		try {
			if (!this.sslKeyPath || !this.sslCertPath) {
				this.logger.warn('SSL ключ или сертификат не указаны в конфигурации');
				return null;
			}
			
			// Обрабатываем относительные пути
			let keyPath = this.sslKeyPath;
			let certPath = this.sslCertPath;
			
			if (!path.isAbsolute(keyPath)) {
				keyPath = path.join(process.cwd(), keyPath);
			}
			if (!path.isAbsolute(certPath)) {
				certPath = path.join(process.cwd(), certPath);
			}
			
			// Читаем файлы сертификатов
			const key = await fs.readFile(keyPath, 'utf8');
			const cert = await fs.readFile(certPath, 'utf8');
			
			this.logger.log(`SSL сертификаты загружены: key=${keyPath}, cert=${certPath}`);
			
			return {
				key,
				cert,
			};
		} catch (error) {
			this.logger.error(`Ошибка загрузки SSL сертификатов: ${(error as Error).message}`);
			return null;
		}
	}
	
	/**
	 * Запуск WebSocket сервера для имитации ncalayer
	 */
	private async startWebSocketServer() {
		try {
			const wsOptions: any = {};
			
			if (this.useHttps) {
				// Настройка WSS (WebSocket Secure)
				const tlsOptions = await this.getTlsOptions();
				if (tlsOptions) {
					const httpsServer = https.createServer({
						key: tlsOptions.key,
						cert: tlsOptions.cert,
					});
					
					httpsServer.listen(this.wsPort, () => {
						this.logger.log(`HTTPS сервер для WSS запущен на порту ${this.wsPort}`);
					});
					
					wsOptions.server = httpsServer;
					this.logger.log(`Запуск WSS сервера с SSL сертификатами`);
				} else {
					this.logger.warn('Не удалось загрузить SSL сертификаты для WSS, запускаем без HTTPS');
					wsOptions.port = this.wsPort;
				}
			} else {
				wsOptions.port = this.wsPort;
			}
			
			this.wsServer = new WebSocketServer(wsOptions);
			
			this.wsServer.on('connection', (ws: WebSocket) => {
				this.logger.log(`Новое ${this.useHttps ? 'WSS' : 'WebSocket'} подключение`);
				
				ws.on('message', async (message: Buffer) => {
					try {
						const data = message.toString();
						this.logger.debug(`Получено WebSocket сообщение: ${data.substring(0, 200)}...`);
						await this.handleWebSocketMessage(ws, data);
					} catch (error) {
						this.logger.error(`Ошибка обработки WebSocket сообщения: ${(error as Error).message}`);
						ws.send(JSON.stringify({
							success: false,
							error: (error as Error).message,
						}));
					}
				});
				
				ws.on('error', (error) => {
					this.logger.error(`Ошибка WebSocket: ${error.message}`);
				});
				
				ws.on('close', () => {
					this.logger.log(`${this.useHttps ? 'WSS' : 'WebSocket'} соединение закрыто`);
				});
				
				// Отправляем приветственное сообщение в формате NCALayer
				ws.send(JSON.stringify({
					result: { version: '1.4' }
				}));
			});
			
			this.wsServer.on('error', (error) => {
				this.logger.error(`Ошибка WebSocket сервера: ${error.message}`);
			});
			
			const protocol = this.useHttps ? 'WSS' : 'WebSocket';
			this.logger.log(`✅ ${protocol} сервер ncalayer запущен на порту ${this.wsPort}`);
		} catch (error) {
			this.logger.error(`Ошибка создания WebSocket сервера: ${(error as Error).message}`);
		}
	}
	
	/**
	 * Безопасная запись в сокет с обработкой ошибок
	 */
	private safeSocketWrite(socket: net.Socket | tls.TLSSocket, data: string): boolean {
		try {
			// Проверяем состояние сокета
			if (socket.destroyed) {
				this.logger.debug('Попытка записи в уничтоженный сокет, пропускаем');
				return false;
			}
			
			// Проверяем, можно ли писать в сокет
			if (!socket.writable || socket.writableEnded) {
				this.logger.debug('Сокет не готов для записи, пропускаем');
				return false;
			}
			
			const result = socket.write(data, (error) => {
				if (error) {
					const err = error as NodeJS.ErrnoException;
					if (err.code === 'EPIPE' || err.code === 'ECONNRESET') {
						this.logger.debug(`Ошибка записи (соединение закрыто): ${err.code}`);
					} else {
						this.logger.error(`Ошибка записи в сокет: ${err.message} (code: ${err.code})`);
					}
				}
			});
			
			if (!result) {
				// Буфер заполнен, ждем события 'drain'
				socket.once('drain', () => {
					this.logger.debug('Буфер сокета освобожден');
				});
			}
			return true;
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			// EPIPE означает, что соединение закрыто на другой стороне
			if (err.code === 'EPIPE' || err.code === 'ECONNRESET') {
				this.logger.debug(`Соединение закрыто клиентом: ${err.code}`);
			} else {
				this.logger.error(`Ошибка записи в сокет: ${err.message} (code: ${err.code || 'unknown'})`);
			}
			return false;
		}
	}
	
	/**
	 * Обработка сообщений через TCP сокет
	 */
	private async handleSocketMessage(socket: net.Socket | tls.TLSSocket, message: string) {
		try {
			let request: any;
			try {
				request = JSON.parse(message);
				this.logger.debug(`Обработка TCP сообщения: ${JSON.stringify(request).substring(0, 200)}...`);
			} catch {
				// Если не JSON, обрабатываем как текстовое сообщение
				const response = {
					success: false,
					error: 'Invalid JSON format',
				};
				this.safeSocketWrite(socket, JSON.stringify(response) + '\n');
				return;
			}
			
			const response = await this.processNcalayerRequest(request);
			this.safeSocketWrite(socket, JSON.stringify(response) + '\n');
		} catch (error) {
			this.logger.error(`Ошибка обработки TCP сообщения: ${(error as Error).message}`);
			const errorResponse = {
				success: false,
				error: (error as Error).message,
			};
			this.safeSocketWrite(socket, JSON.stringify(errorResponse) + '\n');
		}
	}
	
	/**
	 * Обработка сообщений через WebSocket
	 */
	private async handleWebSocketMessage(ws: WebSocket, message: string) {
		try {
			this.logger.debug(`Обработка WebSocket сообщения: ${message.substring(0, 200)}...`);
			
			let request: any;
			try {
				request = JSON.parse(message);
			} catch {
				ws.send(JSON.stringify({
					success: false,
					error: 'Invalid JSON format',
				}));
				return;
			}
			
			const response = await this.processNcalayerRequest(request);
			ws.send(JSON.stringify(response));
		} catch (error) {
			this.logger.error(`Ошибка обработки WebSocket сообщения: ${(error as Error).message}`);
			ws.send(JSON.stringify({
				success: false,
				error: (error as Error).message,
			}));
		}
	}
	
	/**
	 * Обработка запросов ncalayer
	 */
	private async processNcalayerRequest(request: any): Promise<any> {
		try {
			// Обработка рукопожатия (handshake) версии
			if (request.result && request.result.version === '1.4') {
				return { result: { version: '1.4' } };
			}
			
		if (request.module === 'NURSign' && request.type === 'version') {
			this.logger.debug('Обработка запроса NURSign version - возвращаем подтверждение версии');
			return { result: { version: '1.4' } };
		}

			const { module, type, action, ...params } = request;
			
			this.logger.debug(`Обработка запроса: module=${module}, type=${type}, action=${action}`);
			
			// Обработка различных типов запросов ncalayer
			if (module === 'NURSign' || module === 'XML') {
				if (type === 'xml' || action === 'signXML') {
					return await this.handleSignXmlRequest(params);
				}
				if (type === 'multitext') {
					return await this.handleMultitextRequest(request);
				}
			}
			
			if (action === 'getCertInfo' || type === 'info') {
				return await this.handleGetCertInfoRequest(params);
			}
			
			if (action === 'sign' || type === 'sign') {
				return await this.handleSignRequest(params);
			}
			
			// Если запрос не распознан, перенаправляем на HTTP API ncanode
			return await this.forwardToNcanode(request);
		} catch (error) {
			this.logger.error(`Ошибка обработки запроса ncalayer: ${(error as Error).message}`);
			return {
				success: false,
				error: (error as Error).message,
			};
		}
	}
	
	/**
	 * Обработка запроса подписи XML
	 */
	private async handleSignXmlRequest(params: any): Promise<any> {
		try {
			const { xml, data, cert, password, key } = params;
			
			const xmlData = xml || data;
			if (!xmlData) {
				throw new Error('XML данные не указаны');
			}
			
			// Если указан ключ, используем signWithNclayer
			if (key) {
				const certPath = cert || this.configService.get<string>('CERT_PATH', '');
				const certPassword = password || this.configService.get<string>('CERT_PASSWORD', '');
				
				const result = await this.ncanodeService.signWithNclayer(key, certPath, certPassword);
				return {
					success: true,
					xml: typeof result === 'string' ? result : result.xml || result.data,
					result: result,
				};
			}
			
			// Иначе используем обычную подпись XML
			if (!cert || !password) {
				throw new Error('Не указан сертификат или пароль');
			}
			
			const result = await this.ncanodeService.signXml(xmlData, cert, password);
			return {
				success: true,
				xml: typeof result === 'string' ? result : result.xml || result.data,
				result: result,
			};
		} catch (error) {
			this.logger.error(`Ошибка подписи XML через сокет: ${(error as Error).message}`);
			return {
				success: false,
				error: (error as Error).message,
			};
		}
	}
	
	/**
	 * Обработка запроса получения информации о сертификате
	 */
	private async handleGetCertInfoRequest(params: any): Promise<any> {
		try {
			const { cert, password } = params;
			
			if (!cert || !password) {
				throw new Error('Не указан сертификат или пароль');
			}
			
			const result = await this.ncanodeService.getCertInfo(cert, password);
			return {
				success: true,
				result: result,
			};
		} catch (error) {
			this.logger.error(`Ошибка получения информации о сертификате через сокет: ${(error as Error).message}`);
			return {
				success: false,
				error: (error as Error).message,
			};
		}
	}
	
	/**
	 * Обработка запроса multitext (подпись нескольких данных по ключам)
	 */
	private async handleMultitextRequest(request: any): Promise<any> {
		try {
			const { data } = request;
			
			if (!data || typeof data !== 'object') {
				throw new Error('Данные для multitext не указаны или имеют неправильный формат');
			}
			
			const certPath = this.configService.get<string>('CERT_PATH', '');
			const certPassword = this.configService.get<string>('CERT_PASSWORD', '');
			
			if (!certPath || !certPassword) {
				throw new Error('Не указан путь к сертификату или пароль для подписания');
			}
			
			this.logger.debug(`Обработка multitext запроса с ключами: ${Object.keys(data).join(', ')}`);
			
			// Преобразуем объект в JSON строку для подписи
			const dataToSign = JSON.stringify(data);
			
			// Подписываем через ncanode
			const result = await this.ncanodeService.sign(dataToSign, certPath, certPassword, false);
			
			// Возвращаем результат в формате multitext (объект с подписями по ключам)
			// NCALayer возвращает объект вида { "ID_ЛОТА": "ПОДПИСЬ" }
			const signedResult: Record<string, string> = {};
			for (const key of Object.keys(data)) {
				signedResult[key] = result.signature;
			}
			
			return {
				success: true,
				result: signedResult,
			};
		} catch (error) {
			this.logger.error(`Ошибка подписи multitext через сокет: ${(error as Error).message}`);
			return {
				success: false,
				error: (error as Error).message,
			};
		}
	}
	
	/**
	 * Обработка запроса подписи данных
	 */
	private async handleSignRequest(params: any): Promise<any> {
		try {
			const { data, cert, password, withTsp = true } = params;
			
			if (!data || !cert || !password) {
				throw new Error('Не указаны данные, сертификат или пароль');
			}
			
			const dataBuffer = Buffer.from(data, 'base64');
			const result = await this.ncanodeService.sign(dataBuffer, cert, password, withTsp);
			
			return {
				success: true,
				signature: result.signature,
				certificate: result.certificate,
				tsp: result.tsp,
			};
		} catch (error) {
			this.logger.error(`Ошибка подписи через сокет: ${(error as Error).message}`);
			return {
				success: false,
				error: (error as Error).message,
			};
		}
	}
	
	/**
	 * Перенаправление запроса на HTTP API ncanode
	 */
	private async forwardToNcanode(request: any): Promise<any> {
		try {
			this.logger.debug(`Перенаправление запроса на ncanode HTTP API: ${JSON.stringify(request)}`);
			
			// Определяем endpoint на основе типа запроса
			let endpoint = '/xml/sign';
			if (request.type === 'info') {
				endpoint = '/info';
			} else if (request.type === 'sign') {
				endpoint = '/sign';
			} else if (request.type === 'xml') {
				endpoint = '/xml';
			}
			
			const response = await axios.post(`${this.baseUrl}${endpoint}`, request, {
				headers: {
					'Content-Type': 'application/json',
				},
			});
			
			return {
				success: true,
				result: response.data,
			};
		} catch (error) {
			this.logger.error(`Ошибка перенаправления на ncanode: ${(error as AxiosError).message}`);
			return {
				success: false,
				error: (error as AxiosError).message,
				details: (error as AxiosError).response?.data,
			};
		}
	}
	
	/**
	 * Остановка TCP сокет-сервера
	 */
	private stopSocketServer() {
		// if (this.socketServer) {
		// 	this.socketServer.close(() => {
		// 		this.logger.log('TCP сокет-сервер остановлен');
		// 	});
		// 	this.socketServer = null;
		// }
	}
	
	/**
	 * Остановка WebSocket сервера
	 */
	private stopWebSocketServer() {
		if (this.wsServer) {
			this.wsServer.close(() => {
				this.logger.log('WebSocket сервер остановлен');
			});
			this.wsServer = null;
		}
	}
}

