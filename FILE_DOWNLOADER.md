# File Downloader Service

Автоматический сервис загрузки файлов из избранных объявлений на портале goszakup.gov.kz.

## Описание

Сервис работает по расписанию (каждую минуту) и выполняет следующие действия:

1. Получает список избранных объявлений из `/ru/favorites`
2. Фильтрует объявления со статусом "Опубликовано"
3. Для каждого объявления:
   - Получает детали объявления
   - Извлекает ID лотов
   - Скачивает все файлы (документы и подписи)
   - Сохраняет файлы в Redis в формате base64

## Конфигурация

### Переменные окружения

```env
# Включение/выключение сервиса
FILE_DOWNLOADER_ENABLED=true

# Redis (для хранения файлов)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_DB=0
```

## Структура хранения в Redis

### Контент файлов
- **Ключ:** `file:content:{fileId}`
- **Значение:** base64-контент файла
- **TTL:** 24 часа

### Метаданные файлов
- **Ключ:** `file:meta:{fileId}`
- **Значение:** JSON с метаданными
- **TTL:** 24 часа

Пример метаданных:
```json
{
  "fileId": "292795312",
  "fileName": "techspec_84965784.pdf",
  "downloadUrl": "https://v3bl.goszakup.gov.kz/files/download_file/292795312/",
  "lotNumber": "84965784-КРБС1",
  "author": "Джаншина Айгуль Женисовна",
  "organization": "Государственное учреждение...",
  "createdAt": "2026-01-27 08:18:12",
  "signatureUrl": "https://v3bl.goszakup.gov.kz/ru/files/signature/download_cms/m/292795312",
  "contentType": "application/pdf",
  "size": 1234567,
  "downloadedAt": "2026-02-02T10:30:00.000Z"
}
```

### Отметки об обработке
- **Ключ:** `file:processed:{announceId}`
- **Значение:** дата обработки (ISO string)
- **TTL:** 1 час

Используется для предотвращения повторной загрузки файлов в течение часа.

## API методы

### FileDownloaderService

#### `getFavoriteLots(): Promise<FavoriteLot[]>`
Получает список избранных объявлений со статусом "Опубликовано".

#### `getAnnounceDetails(announceId: string): Promise<{lotId: string}[]>`
Получает ID лотов для конкретного объявления.

#### `getFilesList(announceId: string, lotId: string): Promise<FileInfo[]>`
Получает список файлов для конкретного лота.

#### `downloadAndSaveFile(fileInfo: FileInfo): Promise<DownloadedFile | null>`
Скачивает файл и сохраняет в Redis.

#### `downloadAllFiles(announceId: string, lotId: string): Promise<DownloadedFile[]>`
Скачивает все файлы для лота.

#### `getFileFromCache(fileId: string): Promise<DownloadedFile | null>`
Получает файл из кэша Redis.

#### `getFileBuffer(fileId: string): Promise<Buffer | null>`
Получает контент файла в виде Buffer (для подписания).

## Использование в коде

### Получение файла для подписания

```typescript
import { FileDownloaderService } from './modules/file-downloader/file-downloader.service';

// Получить файл в виде Buffer
const fileBuffer = await fileDownloaderService.getFileBuffer('292795312');

if (fileBuffer) {
  // Подписать файл
  const signedData = await ncaService.signData(fileBuffer);
  
  // Отправить подписанный файл
  // ...
}
```

### Получение метаданных файла

```typescript
const file = await fileDownloaderService.getFileFromCache('292795312');

if (file) {
  console.log('Имя файла:', file.fileName);
  console.log('Размер:', file.size);
  console.log('Тип:', file.contentType);
}
```

## Логирование

Сервис логирует следующие события:

- Запуск задачи
- Количество найденных объявлений
- Процесс обработки каждого объявления
- Количество скачанных файлов
- Ошибки при скачивании

## Расписание

По умолчанию сервис запускается **каждую минуту** (`* * * * *`).

Можно изменить в `file-downloader.scheduler.ts`:

```typescript
@Cron('* * * * *') // каждую минуту
@Cron('*/5 * * * *') // каждые 5 минут
@Cron('0 * * * *') // каждый час
```

## Производительность

- **Задержка между файлами:** 500ms
- **Задержка между лотами:** 1000ms
- **Задержка между объявлениями:** 2000ms
- **Защита от повторной обработки:** 1 час

Эти значения помогают избежать перегрузки сервера портала.

## Отключение сервиса

Установите в `.env`:
```env
FILE_DOWNLOADER_ENABLED=false
```

Или остановите приложение.
