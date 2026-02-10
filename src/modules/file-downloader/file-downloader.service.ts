import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '../http/http.service';
import { RedisService } from '../redis/redis.service';
import { PortalService } from '../portal/portal.service';
import { NcanodeService } from '../ncanode/ncanode.service';

/** ID лота из избранного */
export interface FavoriteLotId {
  announceId: string;
  lotId: string; // Из колонки №: "16105049-1" → lotId "1"
}

/** Номер вида документов для actionAjaxModalShowFiles */
export interface DocumentTypeId {
  documentTypeId: string; // Номер вида документов, напр. "3357"
}

export interface FileInfo {
  fileId: string;
  fileName: string;
  downloadUrl: string;
  lotNumber: string;
  author: string;
  organization: string;
  createdAt: string;
  signatureUrl?: string;
  prefix: number; // 1 = основной документ, 2 = дополнительный
  fileIdentifier?: string; // ID файла для подписи (из data-file-identifier)
}

export interface DownloadedFile {
  fileId: string;
  fileName: string;
  content: string; // base64
  contentType: string;
  size: number;
  downloadedAt: string;
  prefix: number;
  redisKey: string; // Ключ в Redis
}

export interface FileKey {
  announceId: string;
  documentTypeId: string; // Номер вида документов (3357)
  prefix: number;
  fileName: string;
}

@Injectable()
export class FileDownloaderService {
  private readonly logger = new Logger(FileDownloaderService.name);
  private readonly fileKeyPrefix = 'file:content:';
  private readonly fileMetaKeyPrefix = 'file:meta:';
  private readonly fileSignaturePrefix = 'file:signature:';
  private readonly fileFormDataPrefix = 'file:formdata:';
  private readonly processedKeyPrefix = 'file:processed:';
  private readonly applicationProcessingPrefix = 'application:processing:';
  private readonly fileTtl = 24 * 60 * 60; // 24 часа

  constructor(
    private httpService: HttpService,
    private redisService: RedisService,
    private configService: ConfigService,
    private portalService: PortalService,
    @Inject(forwardRef(() => NcanodeService))
    private ncanodeService: NcanodeService,
  ) {}

  /**
   * Генерация ключа Redis для файла
   * Формат: file:content:{announceId}-{documentTypeId}-{prefix}-{filename}
   * documentTypeId — номер вида документов (3357)
   */
  generateFileKey(announceId: string, documentTypeId: string, prefix: number, fileName: string): string {
    const sanitizedFileName = this.sanitizeFileName(fileName);
    return `${this.fileKeyPrefix}${announceId}-${documentTypeId}-${prefix}-${sanitizedFileName}`;
  }

  /**
   * Генерация ключа Redis для метаданных файла
   */
  generateMetaKey(announceId: string, documentTypeId: string, prefix: number, fileName: string): string {
    const sanitizedFileName = this.sanitizeFileName(fileName);
    return `${this.fileMetaKeyPrefix}${announceId}-${documentTypeId}-${prefix}-${sanitizedFileName}`;
  }

  /**
   * Санитизация имени файла для использования в ключе Redis
   */
  private sanitizeFileName(fileName: string): string {
    return fileName
      .replace(/\s+/g, '_') // пробелы на подчеркивания
      .replace(/[^\w\-_.а-яёА-ЯЁ]/gi, '') // только буквы, цифры, -, _, .
      .toLowerCase();
  }

  /**
   * Получить список файлов для объявления
   * @param announceId ID объявления
   * @param documentTypeId Номер вида документов (3357) — второй параметр в URL
   */
  async getFilesList(announceId: string, documentTypeId: string): Promise<FileInfo[]> {
    const url = `/ru/announce/actionAjaxModalShowFiles/${announceId}/${documentTypeId}`;
    this.logger.log(`[file-downloader] Запрос списка файлов (номер вида документов: ${documentTypeId}): ${url}`);

    try {
      const response = await this.httpService.get(url, {
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'X-Requested-With': 'XMLHttpRequest',
        },
      });

      if (response.status !== 200) {
        this.logger.warn(`[file-downloader] Неуспешный статус: ${response.status}`);
        return [];
      }

      const html = typeof response.data === 'string' ? response.data : String(response.data);
      return this.parseFilesFromHtml(html, documentTypeId);
    } catch (error) {
      this.logger.error(`[file-downloader] Ошибка получения списка файлов: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * Парсинг HTML для извлечения ссылок на файлы.
   * Логика префикса (1 = основной, 2 = дополнительный) только для documentTypeId 3357.
   * Для остальных видов документов (например 1356) все файлы идут с prefix=1.
   */
  parseFilesFromHtml(html: string, documentTypeId?: string): FileInfo[] {
    const files: FileInfo[] = [];
    const usePrefixLogic = documentTypeId === '3357';

    if (usePrefixLogic) {
      // Только для 3357: разделяем на основные и дополнительные файлы
      const additionalFilesIndex = html.indexOf('Дополнительные файл');
      let mainTableHtml = html;
      let additionalTableHtml = '';

      if (additionalFilesIndex !== -1) {
        mainTableHtml = html.substring(0, additionalFilesIndex);
        additionalTableHtml = html.substring(additionalFilesIndex);
      }

      const mainFiles = this.parseTableFiles(mainTableHtml, 1, '3357');
      files.push(...mainFiles);

      if (additionalTableHtml) {
        const additionalFiles = this.parseTableFiles(additionalTableHtml, 2, '3357');
        files.push(...additionalFiles);
      }

      this.logger.log(`[file-downloader] Найдено ${mainFiles.length} основных и ${files.length - mainFiles.length} дополнительных файлов (3357)`);
    } else {
      // Для 1356 и остальных: одна таблица, все файлы с prefix=1 (формат колонок может отличаться)
      const allFiles = this.parseTableFiles(html, 1, documentTypeId);
      files.push(...allFiles);
      this.logger.log(`[file-downloader] Найдено ${allFiles.length} файлов (documentTypeId=${documentTypeId || '?'})`);
    }

    return files;
  }

  /**
   * Парсинг файлов из таблицы HTML.
   * Для 3357: колонки №, Документ, Автор, Организация, Дата, Подпись (file в cells[1]).
   * Для 1356: колонки Документ, Автор, Организация, Дата создания, Подпись (file в cells[0]).
   */
  private parseTableFiles(html: string, prefix: number, documentTypeId?: string): FileInfo[] {
    const files: FileInfo[] = [];
    const is1356 = documentTypeId === '1356';
    const fileCellIndex = is1356 ? 0 : 1;
    const authorIndex = is1356 ? 1 : 2;
    const orgIndex = is1356 ? 2 : 3;
    const dateIndex = is1356 ? 3 : 4;
    const signCellIndex = is1356 ? 4 : 5;
    const minCells = is1356 ? 5 : 5;

    const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;

    while ((rowMatch = rowPattern.exec(html)) !== null) {
      const rowHtml = rowMatch[1];

      if (rowHtml.includes('<th')) continue;

      const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      const cells: string[] = [];
      let cellMatch;

      while ((cellMatch = cellPattern.exec(rowHtml)) !== null) {
        cells.push(cellMatch[1].trim());
      }

      if (cells.length < minCells) continue;

      const fileCell = cells[fileCellIndex];
      const fileLinkMatch = fileCell.match(/<a\s+href="([^"]+)"[^>]*>([^<]+)<\/a>/i);

      if (!fileLinkMatch) continue;

      const downloadUrl = fileLinkMatch[1];
      const fileName = fileLinkMatch[2].trim();

      const fileIdMatch = downloadUrl.match(/download_file\/(\d+)/);
      if (!fileIdMatch) continue;

      const fileId = fileIdMatch[1];

      const lotNumber = is1356 ? '' : this.stripHtml(cells[0]);
      const author = this.stripHtml(cells[authorIndex]);
      const organization = this.stripHtml(cells[orgIndex]);
      const createdAt = this.stripHtml(cells[dateIndex]);

      let signatureUrl: string | undefined;
      if (cells[signCellIndex]) {
        const signMatch = cells[signCellIndex].match(/<a\s+href="([^"]+)"[^>]*>/i);
        if (signMatch) {
          signatureUrl = signMatch[1];
        }
      }

      let fileIdentifier: string | undefined;
      const buttonMatch = rowHtml.match(/<button[^>]*data-file-identifier=["'](\d+)["'][^>]*>/i);
      if (buttonMatch) {
        fileIdentifier = buttonMatch[1];
      }

      files.push({
        fileId,
        fileName,
        downloadUrl,
        lotNumber,
        author,
        organization,
        createdAt,
        signatureUrl,
        prefix,
        fileIdentifier,
      });
    }

    return files;
  }

  /**
   * Удаление HTML тегов из строки
   */
  private stripHtml(html: string): string {
    return html
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Определить расширение файла
   */
  private getFileExtension(fileName: string, contentType: string): string {
    const match = fileName.match(/\.([a-z0-9]+)$/i);
    if (match) {
      return '.' + match[1].toLowerCase();
    }
    
    // Определяем по Content-Type
    if (contentType.includes('pdf')) return '.pdf';
    if (contentType.includes('xml')) return '.xml';
    if (contentType.includes('zip')) return '.zip';
    if (contentType.includes('rar')) return '.rar';
    if (contentType.includes('docx')) return '.docx';
    if (contentType.includes('doc')) return '.doc';
    
    return '.pdf'; // по умолчанию
  }

  /**
   * Подписать файл через ncanode
   */
  private async signFile(fileBuffer: Buffer, ext: string, taskId: string): Promise<string> {
    try {
      const certPath = this.configService.get<string>('CERT_PATH', '');
      const certPassword = this.configService.get<string>('CERT_PASSWORD', '');

      if (!certPath || !certPassword) {
        throw new Error('Не указан путь к сертификату или пароль');
      }

      let signedData: any;

      // Проверяем, что файл действительно XML перед подписанием как XML
      if (ext === '.xml') {
        try {
          const xmlContent = fileBuffer.toString('utf-8');
          const invalidXmlChars = /[\x00-\x08\x0B-\x0C\x0E-\x1F]/;
          if (invalidXmlChars.test(xmlContent)) {
            this.logger.warn(`[file-downloader] Файл имеет расширение .xml, но содержит недопустимые XML символы. Подписываем как бинарный файл.`);
            signedData = await this.ncanodeService.sign(fileBuffer, certPath, certPassword, true);
          } else {
            signedData = await this.ncanodeService.signWithNclayer(xmlContent, certPath, certPassword);
          }
        } catch (error) {
          this.logger.warn(`[file-downloader] Не удалось обработать файл как XML: ${(error as Error).message}. Подписываем как бинарный файл.`);
          signedData = await this.ncanodeService.sign(fileBuffer, certPath, certPassword, true);
        }
      } else {
        signedData = await this.ncanodeService.sign(fileBuffer, certPath, certPassword, true);
      }

      // Извлекаем подпись
      let signature: string;
      if (ext === '.xml') {
        const xmlContent = typeof signedData === 'string' ? signedData : (signedData.xml || JSON.stringify(signedData));
        const signatureMatch = xmlContent.match(/<[^:]*:?SignatureValue[^>]*>([^<]+)<\/[^:]*:?SignatureValue>/i);
        if (signatureMatch && signatureMatch[1]) {
          signature = signatureMatch[1].trim();
        } else {
          signature = typeof signedData === 'string'
            ? Buffer.from(xmlContent, 'utf-8').toString('base64')
            : Buffer.from(xmlContent).toString('base64');
        }
      } else {
        if (signedData.signature) {
          signature = signedData.signature;
        } else {
          signature = typeof signedData === 'string'
            ? Buffer.from(signedData, 'utf-8').toString('base64')
            : Buffer.from(JSON.stringify(signedData), 'utf-8').toString('base64');
        }
      }

      return signature;
    } catch (error) {
      this.logger.error(`[file-downloader] Ошибка подписания файла: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Сохранить подпись файла в Redis
   */
  private async saveSignature(
    announceId: string,
    documentTypeId: string,
    prefix: number,
    fileName: string,
    signature: string,
  ): Promise<void> {
    const signatureKey = `${this.fileSignaturePrefix}${announceId}-${documentTypeId}-${prefix}-${this.sanitizeFileName(fileName)}`;
    await this.redisService.set(signatureKey, signature, this.fileTtl);
    this.logger.debug(`[file-downloader] Подпись сохранена: ${signatureKey}`);
  }

  /**
   * Сохранить готовый form-data request в Redis
   * Формат как в dataSheetHandle: { send: 'Сохранить', sign_files: '', signature[fileIdentifier]: signature }
   */
  private async saveFormDataRequest(
    announceId: string,
    documentTypeId: string,
    fileIdentifier: string,
    signature: string,
  ): Promise<void> {
    const formDataKey = `${this.fileFormDataPrefix}${announceId}-${documentTypeId}-${fileIdentifier}`;
    
    // Формируем form-data как в dataSheetHandle
    const formData: Record<string, any> = {
      'send': 'Сохранить',
      'sign_files': '',
      [`signature[${fileIdentifier}]`]: signature,
    };

    await this.redisService.set(formDataKey, JSON.stringify(formData), this.fileTtl);
    this.logger.log(`[file-downloader] Готовый form-data request сохранён: ${formDataKey}`);
  }

  /**
   * Получить готовый form-data request из Redis для одного файла
   */
  async getFormDataRequest(announceId: string, documentTypeId: string, fileIdentifier: string): Promise<Record<string, any> | null> {
    const formDataKey = `${this.fileFormDataPrefix}${announceId}-${documentTypeId}-${fileIdentifier}`;
    const formDataStr = await this.redisService.get(formDataKey);
    
    if (!formDataStr) {
      return null;
    }

    try {
      return JSON.parse(formDataStr);
    } catch {
      return null;
    }
  }

  /**
   * Получить объединенный form-data request для всех файлов объявления
   * Объединяет все подписи в один form-data как в dataSheetHandle
   */
  async getCombinedFormDataRequest(announceId: string, documentTypeId: string): Promise<Record<string, any> | null> {
    const files = await this.getFilesList(announceId, documentTypeId);
    const formData: Record<string, any> = {
      'send': 'Сохранить',
      'sign_files': '',
    };

    let hasSignatures = false;
    for (const fileInfo of files) {
      if (fileInfo.fileIdentifier) {
        const signature = await this.getSignature(announceId, documentTypeId, fileInfo.prefix, fileInfo.fileName);
        if (signature) {
          formData[`signature[${fileInfo.fileIdentifier}]`] = signature;
          hasSignatures = true;
        }
      }
    }

    if (!hasSignatures) {
      return null;
    }

    return formData;
  }

  /**
   * Получить подпись файла из Redis
   */
  async getSignature(announceId: string, documentTypeId: string, prefix: number, fileName: string): Promise<string | null> {
    const signatureKey = `${this.fileSignaturePrefix}${announceId}-${documentTypeId}-${prefix}-${this.sanitizeFileName(fileName)}`;
    return await this.redisService.get(signatureKey);
  }

  /**
   * Скачать файл и сохранить в Redis
   * @param fileInfo Информация о файле
   * @param announceId ID объявления
   * @param documentTypeId Номер вида документов (3357)
   * @returns Скачанный файл или null при ошибке
   */
  async downloadAndSaveFile(
    fileInfo: FileInfo,
    announceId: string,
    documentTypeId: string,
  ): Promise<DownloadedFile | null> {
    const { fileId, fileName, downloadUrl, prefix } = fileInfo;
    // Для документов кроме 3357 используем prefix=1 по умолчанию
    const effectivePrefix = documentTypeId === '3357' ? prefix : 1;
    const redisKey = this.generateFileKey(announceId, documentTypeId, effectivePrefix, fileName);

    // Проверяем, есть ли файл в кэше
    const existingContent = await this.redisService.get(redisKey);
    if (existingContent) {
      this.logger.log(`[file-downloader] Файл ${fileName} (prefix=${effectivePrefix}) уже в кэше`);
      
      // Возвращаем существующий файл из кэша
      const metaKey = this.generateMetaKey(announceId, documentTypeId, effectivePrefix, fileName);
      const metaStr = await this.redisService.get(metaKey);
      if (metaStr) {
        try {
          const meta = JSON.parse(metaStr);
          return {
            fileId,
            fileName,
            content: existingContent,
            contentType: meta.contentType,
            size: meta.size,
            downloadedAt: meta.downloadedAt,
            prefix: effectivePrefix,
            redisKey,
          };
        } catch {
          // Если метаданные повреждены, перезагружаем файл
        }
      }
    }

    this.logger.log(`[file-downloader] Скачивание файла ${fileId}: ${fileName} (prefix=${effectivePrefix})`);

    try {
      const response = await this.httpService.get(downloadUrl, {
        responseType: 'arraybuffer',
        headers: {
          'Accept': '*/*',
        },
      });

      if (response.status !== 200) {
        this.logger.warn(`[file-downloader] Ошибка скачивания ${fileId}: статус ${response.status}`);
        return null;
      }

      const buffer = Buffer.from(response.data);
      const base64Content = buffer.toString('base64');
      const contentType = response.headers['content-type'] || 'application/octet-stream';

      // Определяем расширение файла
      const ext = this.getFileExtension(fileName, contentType);

      // Подписываем файл
      this.logger.log(`[file-downloader] Подписание файла ${fileName}...`);
      const signature = await this.signFile(buffer, ext, fileId);

      const downloadedFile: DownloadedFile = {
        fileId,
        fileName,
        content: base64Content,
        contentType,
        size: buffer.length,
        downloadedAt: new Date().toISOString(),
        prefix: effectivePrefix,
        redisKey,
      };

      // Сохраняем файл и подпись в Redis
      await this.saveFileToCache(downloadedFile, fileInfo, announceId, documentTypeId);
      await this.saveSignature(announceId, documentTypeId, effectivePrefix, fileName, signature);

      // Если есть fileIdentifier, формируем готовый form-data request
      if (fileInfo.fileIdentifier) {
        await this.saveFormDataRequest(announceId, documentTypeId, fileInfo.fileIdentifier, signature);
      }

      this.logger.log(`[file-downloader] Файл ${fileName} сохранён (ключ: ${redisKey}), размер: ${buffer.length} байт, подпись сохранена`);
      return downloadedFile;
    } catch (error) {
      this.logger.error(`[file-downloader] Ошибка скачивания ${fileId}: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Сохранить файл в Redis
   */
  private async saveFileToCache(
    file: DownloadedFile,
    meta: FileInfo,
    announceId: string,
    documentTypeId: string,
  ): Promise<void> {
    const contentKey = this.generateFileKey(announceId, documentTypeId, file.prefix, file.fileName);
    const metaKey = this.generateMetaKey(announceId, documentTypeId, file.prefix, file.fileName);

    // Сохраняем контент файла
    await this.redisService.set(contentKey, file.content, this.fileTtl);

    // Сохраняем метаданные
    const metaData = {
      ...meta,
      announceId,
      documentTypeId,
      contentType: file.contentType,
      size: file.size,
      downloadedAt: file.downloadedAt,
      redisKey: contentKey,
    };
    await this.redisService.set(metaKey, JSON.stringify(metaData), this.fileTtl);
  }

  /**
   * Получить файл из кэша по ключу
   * @param documentTypeId Номер вида документов (3357)
   */
  async getFileByKey(announceId: string, documentTypeId: string, prefix: number, fileName: string): Promise<DownloadedFile | null> {
    const contentKey = this.generateFileKey(announceId, documentTypeId, prefix, fileName);
    const metaKey = this.generateMetaKey(announceId, documentTypeId, prefix, fileName);

    const content = await this.redisService.get(contentKey);
    const metaStr = await this.redisService.get(metaKey);

    if (!content || !metaStr) {
      return null;
    }

    try {
      const meta = JSON.parse(metaStr);
      return {
        fileId: meta.fileId,
        fileName: meta.fileName,
        content,
        contentType: meta.contentType,
        size: meta.size,
        downloadedAt: meta.downloadedAt,
        prefix: meta.prefix,
        redisKey: contentKey,
      };
    } catch {
      return null;
    }
  }

  /**
   * Получить контент файла в виде Buffer
   * @param documentTypeId Номер вида документов (3357)
   */
  async getFileBuffer(announceId: string, documentTypeId: string, prefix: number, fileName: string): Promise<Buffer | null> {
    const file = await this.getFileByKey(announceId, documentTypeId, prefix, fileName);
    if (!file) return null;
    return Buffer.from(file.content, 'base64');
  }

  /**
   * Получить все файлы для объявления из кэша
   * @param documentTypeId Номер вида документов (3357)
   */
  async getCachedFilesForLot(announceId: string, documentTypeId: string): Promise<DownloadedFile[]> {
    // Получаем список файлов из портала (для получения имен файлов)
    const filesList = await this.getFilesList(announceId, documentTypeId);
    const cachedFiles: DownloadedFile[] = [];

    for (const fileInfo of filesList) {
      const file = await this.getFileByKey(announceId, documentTypeId, fileInfo.prefix, fileInfo.fileName);
      if (file) {
        cachedFiles.push(file);
      }
    }

    return cachedFiles;
  }

  /**
   * Скачать все файлы для объявления и лота
   */
  async downloadAllFiles(announceId: string, documentTypeId: string): Promise<DownloadedFile[]> {
    const files = await this.getFilesList(announceId, documentTypeId);
    const downloadedFiles: DownloadedFile[] = [];

    for (const fileInfo of files) {
      const downloaded = await this.downloadAndSaveFile(fileInfo, announceId, documentTypeId);
      if (downloaded) {
        downloadedFiles.push(downloaded);
      }
      // Небольшая задержка между запросами
      await this.delay(500);
    }

    this.logger.log(`[file-downloader] Скачано ${downloadedFiles.length} из ${files.length} файлов`);
    return downloadedFiles;
  }

  /**
   * Получить массив ID лотов из избранного (со статусом "Опубликовано")
   */
  async getFavoriteLots(): Promise<FavoriteLotId[]> {
    this.logger.log('[file-downloader] Запрос списка избранных лотов...');

    try {
      const response = await this.portalService.request({
        url: '/ru/favorites',
        method: 'GET',
      });

      if (!response.success) {
        this.logger.warn(`[file-downloader] Неуспешный статус: ${response.status}`);
        return [];
      }

      const html = typeof response.data === 'string' ? response.data : String(response.data);
      return this.parseFavoriteLotsFromHtml(html);
    } catch (error) {
      this.logger.error(`[file-downloader] Ошибка получения избранных лотов: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * Парсинг HTML для извлечения ID лотов из избранного
   */
  parseFavoriteLotsFromHtml(html: string): FavoriteLotId[] {
    const lots: FavoriteLotId[] = [];

    // Ищем все строки таблицы с лотами
    const rowPattern = /<tr\s+class="tr-favorite"[^>]*id="tr_(\d+)"[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;

    while ((rowMatch = rowPattern.exec(html)) !== null) {
      const announceId = rowMatch[1];
      const rowHtml = rowMatch[2];

      // Извлекаем ячейки
      const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      const cells: string[] = [];
      let cellMatch;

      while ((cellMatch = cellPattern.exec(rowHtml)) !== null) {
        cells.push(cellMatch[1].trim());
      }

      // Нужно минимум 10 ячеек
      if (cells.length < 10) continue;

      // Извлекаем статус (последняя ячейка)
      const status = this.stripHtml(cells[9]);

      // Фильтруем только "Опубликовано"
      // if (status !== 'Опубликовано') {
      //   this.logger.debug(`[file-downloader] Пропуск лота ${announceId} со статусом: ${status}`);
      //   continue;
      // }

      // Извлекаем lotId из колонки № (16105049-1 → lotId "1")
      const lotNumberColumn = this.stripHtml(cells[0]);
      const match = lotNumberColumn.match(/^\d+-(\d+)$/);
      const lotId = match ? match[1] : announceId;

      lots.push({ announceId, lotId });
    }

    this.logger.log(`[file-downloader] Найдено ${lots.length} опубликованных лотов в избранном`);
    return lots;
  }

  /**
   * Получить номера видов документов для объявления (из страницы объявления)
   * actionAjaxModalShowFiles/announceId/{documentTypeId} — documentTypeId это номер вида документов (напр. 3357)
   */
  async getDocumentTypeIds(announceId: string): Promise<DocumentTypeId[]> {
    this.logger.log(`[file-downloader] Получение деталей объявления ${announceId}...`);

    try {
      const response = await this.portalService.request({
        url: `/ru/announce/index/${announceId}`,
        method: 'GET',
      });

      if (!response.success) {
        this.logger.warn(`[file-downloader] Неуспешный статус: ${response.status}`);
        return [];
      }

      const html = typeof response.data === 'string' ? response.data : String(response.data);
      return this.parseDocumentTypeIdsFromAnnounce(html);
    } catch (error) {
      this.logger.error(`[file-downloader] Ошибка получения деталей объявления: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * Парсинг номеров видов документов из страницы объявления
   * actionAjaxModalShowFiles/announceId/{documentTypeId} — documentTypeId это номер вида документов (3357)
   */
  parseDocumentTypeIdsFromAnnounce(html: string): DocumentTypeId[] {
    const ids: DocumentTypeId[] = [];
    const foundIds = new Set<string>();

    // Паттерны для поиска documentTypeId (второй числовой ID в actionAjaxModalShowFiles/announceId/documentTypeId)
    const patterns = [
      // Полный URL: https://v3bl.goszakup.gov.kz/ru/announce/actionAjaxModalShowFiles/16105049/3357
      /actionAjaxModalShowFiles\/\d+\/(\d+)/gi,
      // Стандартный путь: /ru/announce/actionAjaxModalShowFiles/16105049/3357
      /\/ru\/announce\/actionAjaxModalShowFiles\/\d+\/(\d+)/gi,
      // Без /ru/: /announce/actionAjaxModalShowFiles/16105049/3357
      /\/announce\/actionAjaxModalShowFiles\/\d+\/(\d+)/gi,
      // В кавычках, атрибутах, JS
      /actionAjaxModalShowFiles[^0-9]*\d+[^\d]*(\d+)/gi,
      // data-lot-id для лотов
      /data-lot-id=["'](\d+)["']/gi,
      // В JavaScript: lotId или lot_id
      /["']lot[_-]?id["']\s*:\s*["']?(\d+)/gi,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(html)) !== null) {
        const documentTypeId = match[1];
        if (documentTypeId && !foundIds.has(documentTypeId)) {
          foundIds.add(documentTypeId);
          ids.push({ documentTypeId });
        }
      }
    }

    if (ids.length === 0) {
      // Отладка: проверяем наличие строки в HTML
      const hasShowFiles = /actionAjaxModalShowFiles/i.test(html);
      const hasShowFilesAlt = /ShowFiles/i.test(html);
      this.logger.debug(`[file-downloader] Отладка: actionAjaxModalShowFiles в HTML: ${hasShowFiles}, ShowFiles: ${hasShowFilesAlt}`);
    }

    this.logger.log(`[file-downloader] Найдено ${ids.length} номеров видов документов в объявлении`);
    return ids;
  }

  /**
   * Проверить, обрабатывалось ли объявление недавно
   */
  async isAnnounceProcessed(announceId: string): Promise<boolean> {
    const key = `${this.processedKeyPrefix}${announceId}`;
    return await this.redisService.exists(key);
  }

  /**
   * Отметить объявление как обработанное
   */
  async markAnnounceAsProcessed(announceId: string): Promise<void> {
    const key = `${this.processedKeyPrefix}${announceId}`;
    // Помечаем на 1 час, чтобы не скачивать одни и те же файлы каждую минуту
    await this.redisService.set(key, new Date().toISOString(), 60 * 60);
  }

  /**
   * Проверить, обрабатывается ли объявление через API start
   */
  async isApplicationProcessing(announceId: string): Promise<boolean> {
    const key = `${this.applicationProcessingPrefix}${announceId}`;
    return await this.redisService.exists(key);
  }

  /**
   * Основная задача, выполняемая по расписанию
   */
  async runDownloadTask(): Promise<void> {
    const taskId = 'file-downloader';
    this.logger.log(`[${taskId}] Запуск задачи...`);

    try {
      // Получаем список избранных лотов со статусом "Опубликовано"
      const favoriteLots = await this.getFavoriteLots();

      if (favoriteLots.length === 0) {
        this.logger.log(`[${taskId}] Нет опубликованных лотов в избранном`);
        return;
      }

      this.logger.log(`[${taskId}] Найдено ${favoriteLots.length} опубликованных лотов`);

      let totalDownloaded = 0;
      for (const lot of favoriteLots) {
        // Проверяем, не обрабатывали ли мы это объявление недавно
        if (await this.isAnnounceProcessed(lot.announceId)) {
          this.logger.log(`[${taskId}] Объявление ${lot.announceId} уже обработано, пропуск`);
          continue;
        }

        // Проверяем, не обрабатывается ли объявление через API start
        // if (await this.isApplicationProcessing(lot.announceId)) {
        //   this.logger.log(`[${taskId}] Объявление ${lot.announceId} обрабатывается через API start, пропуск`);
        //   continue;
        // }

        // Скачиваем документы для видов 1356 и 3357
        const documentTypeIdsToDownload = ['1356', '3357'];
        let downloadedForAnnounce = 0;

        for (const documentTypeId of documentTypeIdsToDownload) {
          this.logger.log(`[${taskId}] Обработка объявления ${lot.announceId}, номер вида документов: ${documentTypeId}`);

          const files = await this.downloadAllFiles(lot.announceId, documentTypeId);
          downloadedForAnnounce += files.length;
          totalDownloaded += files.length;

          await this.delay(1000);
        }

        // Отмечаем объявление как обработанное только если хотя бы один файл скачан и сохранён
        if (downloadedForAnnounce > 0) {
          await this.markAnnounceAsProcessed(lot.announceId);
          this.logger.log(`[${taskId}] Объявление ${lot.announceId} отмечено как обработанное (скачано файлов: ${downloadedForAnnounce})`);
        } else {
          this.logger.warn(`[${taskId}] Объявление ${lot.announceId}: файлы не скачаны, не помечаем как обработанное (повторная попытка в следующем цикле)`);
        }

        await this.delay(2000);
      }

      this.logger.log(`[${taskId}] Задача выполнена. Скачано файлов: ${totalDownloaded}`);
    } catch (error) {
      this.logger.error(`[${taskId}] Ошибка выполнения задачи: ${(error as Error).message}`);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
