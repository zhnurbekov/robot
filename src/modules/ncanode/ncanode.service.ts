import {Injectable, Logger} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import axios, {AxiosError} from 'axios';
import {RedisService} from '../redis/redis.service';

@Injectable()
export class NcanodeService {
	private readonly logger = new Logger(NcanodeService.name);
	private readonly baseUrl: string;
	private readonly certCacheKeyPrefix = 'cert:base64:';
	private readonly certCacheTtl = 24 * 60 * 60; // 24 часа в секундах
	private readonly enableCertCache: boolean;
	
	constructor(
		private configService: ConfigService,
		private redisService: RedisService,
	) {
		this.baseUrl = this.configService.get<string>('NCANODE_URL', 'http://localhost:14579');
		this.enableCertCache = this.configService.get<boolean>('ENABLE_REDIS_CERT_CACHE', true);
	}
	
	/**
	 * Получить сертификат в base64 из кэша или файла
	 * Кэширует сертификат в Redis для быстрого доступа
	 */
	private async getCertBase64(certPath: string): Promise<string> {
		// Обрабатываем относительные пути (от корня проекта)
		const path = await import('path');
		let fullCertPath = certPath;
		if (!path.isAbsolute(certPath)) {
			fullCertPath = path.join(process.cwd(), certPath);
		}
		
		// Формируем ключ кэша на основе пути к файлу и времени модификации
		const fs = await import('fs/promises');
		let cacheKey: string;
		try {
			const stats = await fs.stat(fullCertPath);
			// Используем путь и время модификации для уникальности ключа
			cacheKey = `${this.certCacheKeyPrefix}${fullCertPath}:${stats.mtimeMs}`;
		} catch {
			// Если не удалось получить статистику, используем только путь
			cacheKey = `${this.certCacheKeyPrefix}${fullCertPath}`;
		}
		
		// Пробуем получить из кэша (если кэширование включено)
		if (this.enableCertCache) {
			const cachedCert = await this.redisService.get(cacheKey);
			if (cachedCert) {
				this.logger.debug(`Сертификат получен из кэша: ${fullCertPath}`);
				return cachedCert;
			}
		}
		
		// Если нет в кэше, читаем из файла
		this.logger.debug(`Чтение сертификата из файла: ${fullCertPath}`);
		const certBuffer = await fs.readFile(fullCertPath);
		const certBase64 = certBuffer.toString('base64');
		
		// Сохраняем в кэш (если кэширование включено)
		if (this.enableCertCache) {
			await this.redisService.set(cacheKey, certBase64, this.certCacheTtl);
			this.logger.debug(`Сертификат сохранен в кэш: ${fullCertPath} (${certBuffer.length} байт)`);
		}
		
		return certBase64;
	}
	
	async getCertInfo(certPath: string, password: string) {
		try {
			const response = await axios.post(`${this.baseUrl}/info`, {
				cert: certPath,
				password: password,
			});
			
			return response.data;
		} catch (error) {
			this.logger.error(`Ошибка получения информации о сертификате: ${(error as AxiosError).message}`);
			throw error;
		}
	}
	
	async sign(data: string | Buffer, certPath: string, password: string, withTsp = false) {
		console.log(data,'data')
		try {
			const dataBase64 =	typeof data === 'string' ? Buffer.from(data).toString('base64') : data.toString('base64');
			
			// Получаем сертификат из кэша (Redis или in-memory)
			const certBase64 = await this.getCertBase64(certPath);
			
			// Формируем запрос в новом формате для /cms/sign
			const requestBody: any = {
				data: dataBase64,
				signers: [
					{
						key: certBase64,
						password: password,
						keyAlias: null,
					},
				],
				withTsp: withTsp,
				detached: true,
			};
			
			// Добавляем tsaPolicy только если withTsp = true
			if (withTsp) {
				requestBody.tsaPolicy = 'TSA_GOST_POLICY';
			}
			
			let response;
			try {
				response = await axios.post(`${this.baseUrl}/cms/sign`, requestBody, {
					headers: {
						'Content-Type': 'application/json',
					},
				});
			} catch (error) {
				// Если ошибка связана с TSP и withTsp был true, пробуем без TSP
				if (withTsp && (error as AxiosError).response?.status === 500) {
					const errorMessage = JSON.stringify((error as AxiosError).response?.data || {});
					if (errorMessage.includes('tsp') || errorMessage.includes('TimeStampToken')) {
						this.logger.warn('Ошибка получения TSP, повторяем запрос без TSP');
						requestBody.withTsp = false;
						delete requestBody.tsaPolicy;
						response = await axios.post(`${this.baseUrl}/cms/sign`, requestBody, {
							headers: {
								'Content-Type': 'application/json',
							},
						});
					} else {
						throw error;
					}
				} else {
					throw error;
				}
			}
			
			// Новый формат ответа: { status, message, cms }
			// cms содержит подписанный документ в base64
			if (response.data.cms) {
				return {
					signature: response.data.cms,
					certificate: response.data.certificate,
					tsp: response.data.tsp,
					status: response.data.status,
					message: response.data.message,
				};
			}
			
			// Обратная совместимость со старым форматом
			return {
				signature: response.data.signature,
				certificate: response.data.certificate,
				tsp: response.data.tsp,
			};
		} catch (error) {
			this.logger.error(`Ошибка подписи: ${(error as AxiosError).message}`);
			if ((error as AxiosError).response) {
				this.logger.error(`Статус: ${(error as AxiosError).response?.status}`);
				this.logger.error(`Ответ сервера: ${JSON.stringify((error as AxiosError).response?.data)}`);
			}
			throw error;
		}
	}
	
	
	async signXml(xmlData: string, certPath: string, password: string) {
		try {
			// Используем новый API /xml/sign с кэшированием сертификата
			// Это позволяет использовать кэш Redis вместо чтения файла каждый раз
			const requestBody: any = {
				xml: xmlData,
				signers: [],
				clearSignatures: false,
				trimXml: false,
			};
			
			if (certPath && password) {
				// Получаем сертификат из кэша (Redis или in-memory)
				const certBase64 = await this.getCertBase64(certPath);
				
				// Добавляем signer в массив signers
				requestBody.signers.push({
					key: certBase64,
					password: password,
					keyAlias: null,
				});
			} else {
				throw new Error('Не указан путь к сертификату или пароль');
			}
			
			const response = await axios.post(`${this.baseUrl}/xml/sign`, requestBody, {
				headers: {
					'Content-Type': 'application/json',
				},
			});
			
			// Извлекаем подписанный XML из ответа
			const result = response.data;
			
			if (typeof result === 'string' && result.includes('<?xml')) {
				return result;
			}
			
			if (typeof result === 'object') {
				const xmlFields = ['xml', 'data', 'result', 'signedXml', 'signed', 'signature'];
				for (const field of xmlFields) {
					if (result[field] && typeof result[field] === 'string' && result[field].includes('<?xml')) {
						return result[field];
					}
				}
				
				for (const value of Object.values(result)) {
					if (
						typeof value === 'string' &&
						value.includes('<?xml') &&
						value.includes('<ds:Signature')
					) {
						return value as string;
					}
				}
			}
			
			return result;
		} catch (error) {
			this.logger.error(`Ошибка подписи XML signXml: ${(error as AxiosError).message}`);
			if ((error as AxiosError).response) {
				this.logger.error(`Статус: ${(error as AxiosError).response?.status}`);
				this.logger.error(`Ответ сервера: ${JSON.stringify((error as AxiosError).response?.data)}`);
			}
			throw error;
		}
	}
	
	async signWithNclayer(
		key: string,
		certPath?: string,
		password?: string,
	): Promise<string | { xml?: string; data?: string; [key: string]: any }> {
		try {
			const xmlData = `<?xml version="1.0" encoding="UTF-8" standalone="no"?><root><key>${key}</key></root>`;
			
			this.logger.log('Отправка запроса на подпись XML через /xml/sign...');
			this.logger.debug(`XML для подписи: ${xmlData}`);
			
			// Формат запроса для ncanode API /xml/sign
			// Используем формат с массивом signers
			const requestBody: any = {
				xml: xmlData,
				signers: [],
				clearSignatures: false,
				trimXml: false,
			};
			
			this.logger.debug(`certPath: ${certPath}, password: ${password ? '***' : 'не указан'}`);
			
			// Если указан путь к сертификату и пароль
			if (certPath && password) {
				try {
					// Получаем сертификат из кэша (Redis или in-memory)
					const certBase64 = await this.getCertBase64(certPath);
					
					this.logger.debug(`Сертификат получен, размер: ${certBase64.length} символов base64`);
					
					// Добавляем signer в массив signers
					requestBody.signers.push({
						key: certBase64,
						password: password,
						keyAlias: null,
					});
					
					this.logger.debug(`Signer добавлен в массив signers`);
				} catch (error) {
					this.logger.error(`Ошибка получения сертификата signWithNclayer: ${(error as Error).message}`);
					throw new Error(`Не удалось получить сертификат: ${(error as Error).message}`);
				}
			} else {
				throw new Error('Не указан путь к сертификату или пароль');
			}
			
			this.logger.debug(`Тело запроса к /xml/sign: ${JSON.stringify({
				...requestBody,
				signers: requestBody.signers.map((s: any) => ({
					...s,
					key: s.key ? `[BASE64, ${s.key.length} символов]` : undefined
				}))
			}, null, 2)}`);
			
			const response = await axios.post(`${this.baseUrl}/xml/sign`, requestBody, {
				headers: {
					'Content-Type': 'application/json',
				},
			});
			
			this.logger.log(`Ответ получен, тип: ${typeof response.data}`);
			
			const result = response.data;
			
			if (typeof result === 'string' && result.includes('<?xml')) {
				return result;
			}
			
			if (typeof result === 'object') {
				const xmlFields = ['xml', 'data', 'result', 'signedXml', 'signed', 'signature'];
				for (const field of xmlFields) {
					if (result[field] && typeof result[field] === 'string' && result[field].includes('<?xml')) {
						return result[field];
					}
				}
				
				for (const value of Object.values(result)) {
					if (
						typeof value === 'string' &&
						value.includes('<?xml') &&
						value.includes('<ds:Signature')
					) {
						return value as string;
					}
				}
			}
			
			return result as string | { xml?: string; data?: string; [key: string]: any };
		} catch (error) {
			this.logger.error(`Ошибка подписи через nclayer: ${(error as AxiosError).message}`);
			if ((error as AxiosError).response) {
				this.logger.error(`Статус: ${(error as AxiosError).response?.status}`);
				this.logger.error(`Ответ сервера: ${JSON.stringify((error as AxiosError).response?.data)}`);
			}
			throw error;
		}
	}
	
	async healthCheck(): Promise<boolean> {
		try {
			const response = await axios.get(`${this.baseUrl}/health`, {
				timeout: 5000,
			});
			return response.status === 200;
		} catch (error) {
			this.logger.error(`Сервис недоступен: ${(error as AxiosError).message}`);
			return false;
		}
	}
}

