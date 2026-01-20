import {Injectable, Logger, OnModuleDestroy} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {WebSocket} from 'ws';

@Injectable()
export class NclayerService implements OnModuleDestroy {
	private readonly logger = new Logger(NclayerService.name);
	private readonly url: string;
	
	constructor(private configService: ConfigService) {
		// По умолчанию используем порт 13579 для реального NCALayer
		const port = this.configService.get<number>('NCALAYER_WS_PORT', 13579);
		// Реальный NCALayer обычно использует WSS (защищенное соединение)
		const useHttps = this.configService.get<string>('NCALAYER_USE_HTTPS', 'true') === 'true';
		const protocol = useHttps ? 'wss' : 'ws';
		this.url = `wss://127.0.0.1:13579/`;
		this.logger.log(`NclayerService инициализирован с URL: ${this.url}`);
	}
	private ws: WebSocket | null = null;
	private handshakeStep = 0;
	private pendingResolve: ((value: string) => void) | null = null;
	private pendingReject: ((error: Error) => void) | null = null;
	private connectionPromise: Promise<void> | null = null;

	onModuleDestroy() {
		this.disconnect();
	}

	private disconnect() {
		if (this.ws) {
			this.ws.terminate();
			this.ws = null;
		}
		this.handshakeStep = 0;
	}

	async connect(): Promise<void> {
		// Если уже подключены и рукопожатие завершено, ничего не делаем
		if (this.ws && this.ws.readyState === WebSocket.OPEN && this.handshakeStep === 2) {
			return;
		}

		// Если есть активный промис подключения, ждем его
		if (this.connectionPromise) {
			try {
				await this.connectionPromise;
				return;
			} catch (error) {
				// Если предыдущая попытка провалилась, разрешаем новую
				this.connectionPromise = null;
			}
		}

		this.connectionPromise = new Promise((resolve, reject) => {
			this.logger.log(`Подключение к NCALayer (${this.url})...`);
			
			// Очищаем старое соединение перед созданием нового
			this.disconnect();
			
			// Добавляем заголовки как в браузере, особенно Origin - NCALayer может проверять его
			const origin = this.configService.get<string>('NCALAYER_ORIGIN', 'https://v3bl.goszakup.gov.kz');
			const headers: Record<string, string> = {
				'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
				'Origin': origin,
			};
			
			this.ws = new WebSocket(this.url, {
				rejectUnauthorized: false,
				headers: headers
			});
			
			this.logger.debug(`WebSocket заголовки: ${JSON.stringify(headers)}`);

		



			this.ws.on('open', () => {
				this.logger.log('Соединение с NCALayer установлено, ожидание версии...');
			});

			this.ws.on('message', (message) => {
				try {
					const response = JSON.parse(message.toString());
					this.logger.debug(`Получено сообщение от NCALayer: ${JSON.stringify(response)}`);
					
					// При получении версии 1.4 сразу считаем рукопожатие завершенным
					// Реальный NCALayer не требует дополнительных шагов
					if (response.result && response.result.version === '1.4' && this.handshakeStep === 0) {
						this.logger.log('Получена версия 1.4, рукопожатие с NCALayer успешно завершено');
						this.handshakeStep = 2;
						this.connectionPromise = null;
						resolve();
						return;
					}

					// Обработка ответов на запросы (подпись и другие сообщения)
					if (this.handshakeStep === 2 && (this.pendingResolve || this.pendingReject)) {
						if (response.status === '200' || response.success || response.result) {
							const result = response.result || response.data;
							if (this.pendingResolve) {
								this.pendingResolve(result);
								this.pendingResolve = null;
								this.pendingReject = null;
							}
						} else {
							if (this.pendingReject) {
								this.pendingReject(new Error(response.message || 'Ошибка NCALayer: ' + JSON.stringify(response)));
								this.pendingResolve = null;
								this.pendingReject = null;
							}
						}
					}

				} catch (error) {
					this.logger.error(`Ошибка обработки сообщения NCALayer: ${(error as Error).message}`);
					if (this.handshakeStep < 2) {
						this.connectionPromise = null;
						reject(error);
					} else if (this.pendingReject) {
						this.pendingReject(error as Error);
						this.pendingResolve = null;
						this.pendingReject = null;
					}
				}
			});

			this.ws.on('error', (error) => {
				this.logger.error(`Ошибка WebSocket NCALayer: ${error.message}`);
				this.disconnect();
		
			});

			this.ws.on('close', (code, reason) => {
				this.logger.warn(`Соединение с NCALayer закрыто. Код: ${code}, Причина: ${reason.toString()}, handshakeStep: ${this.handshakeStep}`);
				if (this.handshakeStep < 2) {
					this.connectionPromise = null;
					reject(new Error(`Соединение с NCALayer закрыто до завершения рукопожатия (код: ${code}, причина: ${reason.toString()})`));
				} else {
					this.disconnect();
				}
			});
		});

		return this.connectionPromise;
	}

	async sign(data: any): Promise<any> {
		// Пытаемся подключиться, если не подключены
		// try {
		// 	await this.connect();
		// } catch (error) {
		// 	this.logger.warn(`Ошибка подключения к NCALayer: ${(error as Error).message}, попытка переподключения...`);
		// 	// Сбрасываем состояние и пробуем еще раз
		// 	this.connectionPromise = null;
		// 	await this.connect();
		// }


		return new Promise((resolve, reject) => {
			this.pendingResolve = resolve;
			this.pendingReject = reject;

			this.logger.log('Отправка запроса NURSign/multitext в NCALayer...');
			const request = {
				module: 'NURSign',
				type: 'multitext',
				data: data,
				source:'local'
			};
			
			console.log(request,'request')

			try {
				this.ws?.send(JSON.stringify(request));
			} catch (error) {
				this.pendingResolve = null;
				this.pendingReject = null;
				reject(error);
			}
		});
	}

	/**
	 * Отправка произвольного сообщения через WebSocket к NCALayer
	 * @param message - Сообщение для отправки (объект, который будет сериализован в JSON)
	 * @param timeout - Таймаут ожидания ответа в миллисекундах (по умолчанию 60000)
	 * @returns Promise с ответом от NCALayer
	 */
	async sendMessage(message: any, timeout: number = 60000): Promise<any> {
		// Пытаемся подключиться, если не подключены

		return new Promise((resolve, reject) => {
			this.pendingResolve = resolve;
			this.pendingReject = reject;

			this.logger.log(`Отправка сообщения в NCALayer: ${JSON.stringify(message).substring(0, 200)}...`);



			try {
				const messageStr = typeof message === 'string' ? message : JSON.stringify(message);
				this.ws?.send(messageStr);
			} catch (error) {
				this.pendingResolve = null;
				this.pendingReject = null;
				reject(error);
			}
		});
	}
}
