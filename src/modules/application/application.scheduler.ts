import {Injectable, Logger, OnModuleInit} from '@nestjs/common';
import {Interval} from '@nestjs/schedule';
import {ConfigService} from '@nestjs/config';
import {PortalProcessorService} from "../portal-processor/portal-processor.service";
import {ApplicationService} from './application.service';
import {AuthService} from '../auth/auth.service';
import {NcanodeService} from '../ncanode/ncanode.service';
import * as fs from 'fs/promises';
import * as path from 'path';

@Injectable()
export class ApplicationScheduler implements OnModuleInit {
	private readonly logger = new Logger(ApplicationScheduler.name);
	
	constructor(
		private configService: ConfigService,
		private applicationService: ApplicationService,
		private authService: AuthService,
		private ncanodeService: NcanodeService,
		private portalProcessorService: PortalProcessorService,
	) {
	}
	
	onModuleInit() {
		// Получаем интервал из конфигурации (в миллисекундах)
		const intervalMs = this.configService.get<number>('CRON_INTERVAL_MS', 2 * 60 * 1000); // По умолчанию 2 минуты
		const intervalMinutes = intervalMs / 1000 / 60;
		
		this.logger.log('ApplicationScheduler инициализирован');
		this.logger.log(`Interval job "submit-applications" зарегистрирован: каждые ${intervalMinutes} минут (${intervalMs}ms)`);
		console.log('[ApplicationScheduler] Инициализирован');
		console.log(`[ApplicationScheduler] Interval job зарегистрирован: каждые ${intervalMinutes} минут`);
		
	}
	
	// Используем @Interval вместо @Cron для более простой настройки
	// Интервал в миллисекундах (2 минуты = 120000 мс)
	// Можно настроить через CRON_INTERVAL_MS в .env
	@Interval(40 * 60 * 1000)
	async handleInterval() {
		const cronEnabled = this.configService.get<string>('CRON_ENABLED', 'false') === 'true';
		// if (!cronEnabled) {
		//   this.logger.warn('Cron отключен в конфигурации (CRON_ENABLED=false)');
		//   return;
		// }
		
		const intervalMs = this.configService.get<number>('CRON_INTERVAL_MS', 2 * 60 * 1000);
		const intervalMinutes = intervalMs / 1000 / 60;
		
		console.log(`=== [INTERVAL] Запуск задачи (каждые ${intervalMinutes} минут) ===`);
		this.logger.log(`=== Запуск задачи по интервалу (каждые ${intervalMinutes} минут) ===`);
		console.log(`[INTERVAL] CRON_ENABLED: ${cronEnabled}`);
		
		try {
			// Проверяем доступность ncanode
			// const ncanodeAvailable = await this.ncanodeService.healthCheck();
			// if (!ncanodeAvailable) {
			//   throw new Error('ncanode недоступен');
			// }
			this.logger.log('ncanode доступен');
			
			// Авторизация
			await this.authService.login();
			this.logger.log('Авторизация выполнена');
			
			const announcementsId = await this.portalProcessorService.processAnnouncementSearch()
			if (announcementsId) {
				await this.portalProcessorService.processAnnouncementCreate(announcementsId)
			}
			
			
		} catch (error) {
			this.logger.error(`Ошибка выполнения задачи: ${error.message}`);
			throw error;
		}
	}
	
}

