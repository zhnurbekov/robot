import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ISessionStorage, SessionData } from './session.interface';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Сервис для хранения сессии в файле
 */
@Injectable()
export class SessionStorageService implements ISessionStorage {
  private readonly logger = new Logger(SessionStorageService.name);
  private readonly sessionFilePath: string;
  private readonly sessionTtl: number; // Время жизни сессии в миллисекундах (по умолчанию 2 минуты)

  constructor(private configService: ConfigService) {
    const sessionDir = path.join(process.cwd(), 'data', 'sessions');
    this.sessionFilePath = path.join(sessionDir, 'session.json');
    // TTL сессии: 2 минуты по умолчанию (для тестирования)
    // Можно переопределить через SESSION_TTL в .env (в миллисекундах)
    this.sessionTtl = this.configService.get<number>('SESSION_TTL', 2 * 60 * 1000); // 2 минуты = 120000 мс
    this.logger.log(`TTL сессии установлен: ${this.sessionTtl / 1000} секунд (${this.sessionTtl / 1000 / 60} минут)`);
    
    // Создаем директорию если не существует
    this.ensureSessionDir();
  }

  private async ensureSessionDir() {
    try {
      const sessionDir = path.dirname(this.sessionFilePath);
      await fs.mkdir(sessionDir, { recursive: true });
    } catch (error) {
      this.logger.error(`Ошибка создания директории для сессий: ${error.message}`);
    }
  }

  async saveSession(sessionData: SessionData): Promise<void> {
    try {
      const dataToSave = {
        ...sessionData,
        expiresAt: sessionData.expiresAt || Date.now() + this.sessionTtl,
      };

      await fs.writeFile(this.sessionFilePath, JSON.stringify(dataToSave, null, 2), 'utf-8');
      this.logger.log('Сессия сохранена');
    } catch (error) {
      this.logger.error(`Ошибка сохранения сессии: ${error.message}`);
      throw error;
    }
  }

  async loadSession(): Promise<SessionData | null> {
    try {
      const fileContent = await fs.readFile(this.sessionFilePath, 'utf-8');
      const sessionData: SessionData = JSON.parse(fileContent);

      // Проверяем валидность
      if (!this.isSessionValid(sessionData)) {
        this.logger.log('Сессия истекла или невалидна');
        await this.clearSession();
        return null;
      }

      this.logger.log('Сессия загружена');
      return sessionData;
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        this.logger.log('Файл сессии не найден');
        return null;
      }
      this.logger.error(`Ошибка загрузки сессии: ${error.message}`);
      return null;
    }
  }

  async clearSession(): Promise<void> {
    try {
      await fs.unlink(this.sessionFilePath).catch(() => {
        // Игнорируем ошибку если файл не существует
      });
      this.logger.log('Сессия очищена');
    } catch (error) {
      this.logger.error(`Ошибка очистки сессии: ${error.message}`);
    }
  }

  isSessionValid(sessionData: SessionData): boolean {
    if (!sessionData.isAuthenticated) {
      return false;
    }

    // Проверяем срок действия
    if (sessionData.expiresAt && Date.now() > sessionData.expiresAt) {
      return false;
    }

    // Проверяем наличие токена или cookies
    if (!sessionData.token && (!sessionData.cookies || sessionData.cookies.length === 0)) {
      return false;
    }

    return true;
  }
}


