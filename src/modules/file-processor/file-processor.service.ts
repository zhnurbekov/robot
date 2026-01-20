import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '../http/http.service';
import { NcanodeService } from '../ncanode/ncanode.service';
import axios from 'axios';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import FormData from 'form-data';

export interface FileProcessingTask {
  id: string;
  url: string; // URL для получения ссылки на файл
  method?: 'GET' | 'POST';
  requestData?: any; // Данные для POST запроса
  uploadUrl: string; // URL для отправки подписанного файла
  uploadMethod?: 'POST' | 'PUT';
  uploadData?: any; // Дополнительные данные для загрузки
}

export interface FileProcessingResult {
  taskId: string;
  success: boolean;
  fileUrl?: string;
  downloadedFilePath?: string;
  signedFilePath?: string;
  uploadResponse?: any;
  error?: string;
  duration?: number;
}

@Injectable()
export class FileProcessorService {
  private readonly logger = new Logger(FileProcessorService.name);
  private readonly tempDir: string;

  constructor(
    private httpService: HttpService,
    private ncanodeService: NcanodeService,
    private configService: ConfigService,
  ) {
    // Создаем временную директорию для файлов
    this.tempDir = path.join(os.tmpdir(), 'goszakup-files');
    this.ensureTempDir();
  }

  /**
   * Создать временную директорию если её нет
   */
  private async ensureTempDir(): Promise<void> {
    try {
      await fs.mkdir(this.tempDir, { recursive: true });
    } catch (error) {
      this.logger.error(`Ошибка создания временной директории: ${(error as Error).message}`);
    }
  }

  /**
   * Обработать один файл: получить ссылку → скачать → подписать → отправить
   */
  async processFile(task: FileProcessingTask): Promise<FileProcessingResult> {
    const startTime = Date.now();
    const taskId = task.id;

    this.logger.log(`[${taskId}] Начало обработки файла`);

    try {
      // Шаг 1: Получить ссылку на файл
      this.logger.log(`[${taskId}] Шаг 1: Получение ссылки на файл...`);
      const fileUrl = await this.getFileUrl(task);
      
      if (!fileUrl) {
        throw new Error('Не удалось получить ссылку на файл');
      }

      this.logger.log(`[${taskId}] Ссылка на файл получена: ${fileUrl}`);

      // Шаг 2: Скачать файл
      this.logger.log(`[${taskId}] Шаг 2: Скачивание файла...`);
      const downloadedFilePath = await this.downloadFile(fileUrl, taskId);
      
      this.logger.log(`[${taskId}] Файл скачан: ${downloadedFilePath}`);

      // Шаг 3: Подписать файл через ncanode
      this.logger.log(`[${taskId}] Шаг 3: Подписание файла через ncanode...`);
      const signedFilePath = await this.signFile(downloadedFilePath, taskId);
      
      this.logger.log(`[${taskId}] Файл подписан: ${signedFilePath}`);

      // Шаг 4: Отправить подписанный файл
      this.logger.log(`[${taskId}] Шаг 4: Отправка подписанного файла...`);
      const uploadResponse = await this.uploadFile(signedFilePath, task);
      
      this.logger.log(`[${taskId}] Файл отправлен успешно`);

      // Очистка временных файлов
      await this.cleanupFiles([downloadedFilePath, signedFilePath]);

      const duration = Date.now() - startTime;
      this.logger.log(`[${taskId}] Обработка завершена за ${duration}ms`);

      return {
        taskId,
        success: true,
        fileUrl,
        downloadedFilePath,
        signedFilePath,
        uploadResponse,
        duration,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = (error as Error).message;
      this.logger.error(`[${taskId}] Ошибка обработки файла: ${errorMessage}`);

      return {
        taskId,
        success: false,
        error: errorMessage,
        duration,
      };
    }
  }

  /**
   * Получить ссылку на файл из HTTPS запроса
   */
  private async getFileUrl(task: FileProcessingTask): Promise<string> {
    try {
      let response;
      
      if (task.method === 'POST') {
        response = await this.httpService.post(task.url, task.requestData || {});
      } else {
        response = await this.httpService.get(task.url);
      }

      // Извлекаем ссылку на файл из ответа
      // Может быть в разных форматах: JSON, HTML, текст
      const fileUrl = this.extractFileUrl(response.data);
      
      if (!fileUrl) {
        throw new Error('Ссылка на файл не найдена в ответе');
      }

      return fileUrl;
    } catch (error) {
      this.logger.error(`Ошибка получения ссылки на файл: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Извлечь URL файла из ответа
   */
  private extractFileUrl(data: any): string | null {
    // Если это строка (HTML или текст)
    if (typeof data === 'string') {
      // Ищем URL в HTML (например, в атрибуте href, src, или в ссылке на скачивание)
      const urlPatterns = [
        /href\s*=\s*["']([^"']+\.(pdf|doc|docx|xml|zip|rar))["']/i,
        /src\s*=\s*["']([^"']+\.(pdf|doc|docx|xml|zip|rar))["']/i,
        /download\s*=\s*["']([^"']+)["']/i,
        /(https?:\/\/[^\s"']+\.(pdf|doc|docx|xml|zip|rar))/i,
        /data-file-identifier\s*=\s*["']([^"']+)["']/i,
      ];

      for (const pattern of urlPatterns) {
        const match = data.match(pattern);
        if (match && match[1]) {
          return match[1];
        }
      }

      // Если это просто URL
      if (data.startsWith('http://') || data.startsWith('https://')) {
        return data.trim();
      }
    }

    // Если это объект (JSON)
    if (typeof data === 'object' && data !== null) {
      // Проверяем различные возможные поля
      const possibleFields = [
        'fileUrl', 'file_url', 'url', 'downloadUrl', 'download_url',
        'link', 'fileLink', 'file_link', 'href', 'src',
        'data', 'file', 'document', 'result',
      ];

      for (const field of possibleFields) {
        if (data[field] && typeof data[field] === 'string') {
          if (data[field].startsWith('http://') || data[field].startsWith('https://')) {
            return data[field];
          }
        }
      }

      // Рекурсивно ищем в вложенных объектах
      for (const value of Object.values(data)) {
        if (typeof value === 'object' && value !== null) {
          const found = this.extractFileUrl(value);
          if (found) return found;
        } else if (typeof value === 'string' && (value.startsWith('http://') || value.startsWith('https://'))) {
          return value;
        }
      }
    }

    return null;
  }

  /**
   * Скачать файл по URL
   */
  private async downloadFile(fileUrl: string, taskId: string): Promise<string> {
    try {
      this.logger.debug(`[${taskId}] Скачивание файла с ${fileUrl}`);

      // Определяем расширение файла
      const urlPath = new URL(fileUrl).pathname;
      const ext = path.extname(urlPath) || '.tmp';
      const fileName = `${taskId}-${Date.now()}${ext}`;
      const filePath = path.join(this.tempDir, fileName);

      // Скачиваем файл
      const response = await axios({
        method: 'GET',
        url: fileUrl,
        responseType: 'stream',
        timeout: 60000, // 60 секунд таймаут
      });

      // Сохраняем файл
      const writer = fsSync.createWriteStream(filePath);
      response.data.pipe(writer);

      await new Promise((resolve, reject) => {
        // writer.on('finish', resolve);
        // writer.on('error', reject);
      });

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
  private async signFile(filePath: string, taskId: string): Promise<string> {
    try {
      // Читаем файл
      const fileBuffer = await fs.readFile(filePath);
      
      // Получаем путь к сертификату и пароль
      const certPath = this.configService.get<string>('CERT_PATH', '');
      const certPassword = this.configService.get<string>('CERT_PASSWORD', '');

      if (!certPath || !certPassword) {
        throw new Error('Не указан путь к сертификату или пароль');
      }

      // Подписываем файл
      // Определяем тип файла по расширению
      const ext = path.extname(filePath).toLowerCase();
      
      let signedData: any;
      
      if (ext === '.xml') {
        // Для XML используем signXml
        const xmlContent = fileBuffer.toString('utf-8');
        signedData = await this.ncanodeService.signWithNclayer(xmlContent, certPath, certPassword);
      } else {
        // Для других файлов используем обычную подпись
        signedData = await this.ncanodeService.sign(fileBuffer, certPath, certPassword, true);
      }

      // Сохраняем подписанный файл
      const signedFileName = `${taskId}-signed-${Date.now()}${ext}`;
      const signedFilePath = path.join(this.tempDir, signedFileName);

      if (typeof signedData === 'string') {
        // Если это XML строка
        await fs.writeFile(signedFilePath, signedData, 'utf-8');
      } else if (signedData.xml) {
        // Если это объект с полем xml
        await fs.writeFile(signedFilePath, signedData.xml, 'utf-8');
      } else if (signedData.signature) {
        // Если это объект с подписью, сохраняем подпись
        await fs.writeFile(signedFilePath, signedData.signature, 'base64');
      } else {
        // Сохраняем как JSON
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
   * Отправить подписанный файл на сервер
   */
  private async uploadFile(filePath: string, task: FileProcessingTask): Promise<any> {
    try {
      // Читаем файл
      const fileBuffer = await fs.readFile(filePath);
      const fileName = path.basename(filePath);

      // Определяем метод отправки
      const method = task.uploadMethod || 'POST';

      if (method === 'POST') {
        // Используем FormData для отправки файла
        const formDataObj: Record<string, any> = {};
        
        // Добавляем файл (может быть Buffer или Stream)
        formDataObj['file'] = fileBuffer;
        
        // Добавляем дополнительные данные если есть
        if (task.uploadData) {
          Object.assign(formDataObj, task.uploadData);
        }

        // Отправляем через httpService
        const response = await this.httpService.postFormData(task.uploadUrl, formDataObj);

        return response.data;
      } else {
        // Для PUT отправляем файл напрямую
        const response = await axios.put(task.uploadUrl, fileBuffer, {
          headers: {
            'Content-Type': 'application/octet-stream',
            ...(task.uploadData || {}),
          },
        });

        return response.data;
      }
    } catch (error) {
      this.logger.error(`Ошибка отправки файла: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Параллельная обработка нескольких файлов
   */
  async processFilesParallel(tasks: FileProcessingTask[]): Promise<FileProcessingResult[]> {
    this.logger.log(`Запуск параллельной обработки ${tasks.length} файлов...`);
    const startTime = Date.now();

    try {
      // Запускаем все задачи параллельно
      const results = await Promise.allSettled(
        tasks.map(task => this.processFile(task))
      );

      // Преобразуем результаты
      const processedResults: FileProcessingResult[] = results.map((result, index) => {
        if (result.status === 'fulfilled') {
          return result.value;
        } else {
          return {
            taskId: tasks[index].id,
            success: false,
            error: result.reason?.message || 'Unknown error',
          };
        }
      });

      const duration = Date.now() - startTime;
      const successCount = processedResults.filter(r => r.success).length;
      
      this.logger.log(
        `Параллельная обработка завершена: ${successCount}/${tasks.length} успешно за ${duration}ms`
      );

      return processedResults;
    } catch (error) {
      this.logger.error(`Ошибка параллельной обработки: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Очистка временных файлов
   */
  private async cleanupFiles(filePaths: string[]): Promise<void> {
    for (const filePath of filePaths) {
      try {
        await fs.unlink(filePath);
        this.logger.debug(`Временный файл удален: ${filePath}`);
      } catch (error) {
        this.logger.warn(`Не удалось удалить временный файл ${filePath}: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Очистка всех временных файлов в директории
   */
  async cleanupAllTempFiles(): Promise<void> {
    try {
      const files = await fs.readdir(this.tempDir);
      for (const file of files) {
        const filePath = path.join(this.tempDir, file);
        try {
          await fs.unlink(filePath);
        } catch (error) {
          this.logger.warn(`Не удалось удалить файл ${filePath}: ${(error as Error).message}`);
        }
      }
      this.logger.log('Все временные файлы очищены');
    } catch (error) {
      this.logger.error(`Ошибка очистки временных файлов: ${(error as Error).message}`);
    }
  }
}

