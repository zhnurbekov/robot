import fs from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Простой логгер с записью в файл
 */
class Logger {
  constructor(config) {
    this.config = config;
    this.logFile = config.logging.file;
    this.level = config.logging.level || 'info';
    this.levels = {
      error: 0,
      warn: 1,
      info: 2,
      debug: 3,
    };
  }

  async ensureLogDir() {
    const logDir = dirname(this.logFile);
    try {
      await fs.mkdir(logDir, { recursive: true });
    } catch (error) {
      // Игнорируем ошибку, если директория уже существует
    }
  }

  async writeLog(level, message, data = null) {
    if (this.levels[level] > this.levels[this.level]) {
      return;
    }

    await this.ensureLogDir();

    const timestamp = new Date().toISOString();
    const logMessage = data
      ? `[${timestamp}] [${level.toUpperCase()}] ${message} ${JSON.stringify(data)}\n`
      : `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;

    try {
      await fs.appendFile(this.logFile, logMessage);
    } catch (error) {
      console.error('Ошибка записи в лог:', error.message);
    }

    // Также выводим в консоль
    if (data) {
      console.log(`[${level.toUpperCase()}] ${message}`, data);
    } else {
      console.log(`[${level.toUpperCase()}] ${message}`);
    }
  }

  async error(message, data = null) {
    await this.writeLog('error', message, data);
  }

  async warn(message, data = null) {
    await this.writeLog('warn', message, data);
  }

  async info(message, data = null) {
    await this.writeLog('info', message, data);
  }

  async debug(message, data = null) {
    await this.writeLog('debug', message, data);
  }
}

export default Logger;



















