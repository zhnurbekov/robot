import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly botToken: string | null;
  private readonly chatId: string | null;
  private readonly enabled: boolean;
  private readonly apiUrl: string;

  constructor(private configService: ConfigService) {
    this.botToken = this.configService.get<string>('TELEGRAM_BOT_TOKEN', '');
    this.chatId = this.configService.get<string>('TELEGRAM_CHAT_ID', '');
    this.enabled = this.configService.get<string>('TELEGRAM_ENABLED', 'true') === 'true';
    
    if (this.botToken) {
      this.apiUrl = `https://api.telegram.org/bot${this.botToken}`;
    }

    if (this.enabled && (!this.botToken || !this.chatId)) {
      this.logger.warn('Telegram уведомления включены, но не указаны TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID');
    }
  }

  /**
   * Отправить сообщение в Telegram канал
   * @param message - Текст сообщения
   * @param parseMode - Режим парсинга (HTML, Markdown)
   */
  async sendMessage(message: string, parseMode: 'HTML' | 'Markdown' = 'HTML'): Promise<boolean> {
    if (!this.enabled) {
      this.logger.debug('Telegram уведомления отключены');
      return false;
    }

    if (!this.botToken || !this.chatId) {
      this.logger.warn('Не указаны TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID, уведомление не отправлено');
      return false;
    }

    try {
      const response = await axios.post(`${this.apiUrl}/sendMessage`, {
        chat_id: this.chatId,
        text: message,
        parse_mode: parseMode === 'HTML' ? 'HTML' : 'Markdown',
        disable_web_page_preview: true,
      }, {
        timeout: 10000,
      });

      if (response.data.ok) {
        this.logger.debug('Сообщение успешно отправлено в Telegram');
        return true;
      } else {
        this.logger.warn(`Ошибка отправки сообщения в Telegram: ${response.data.description || 'Unknown error'}`);
        return false;
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        this.logger.error(`Ошибка при отправке сообщения в Telegram: ${error.message}`);
        if (error.response) {
          this.logger.error(`Ответ от Telegram API: ${JSON.stringify(error.response.data)}`);
        }
      } else {
        this.logger.error(`Ошибка при отправке сообщения в Telegram: ${(error as Error).message}`);
      }
      return false;
    }
  }

  /**
   * Отправить уведомление о завершении обработки заявки
   * @param announceId - ID объявления
   * @param status - Статус обработки (success/error)
   * @param startTime - Время начала обработки (ISO string или Date)
   * @param endTime - Время окончания обработки (ISO string или Date)
   * @param durationMs - Длительность выполнения в миллисекундах
   * @param errorMessage - Сообщение об ошибке (если есть)
   */
  async sendApplicationNotification(
    announceId: string,
    status: 'success' | 'error',
    startTime: string | Date,
    endTime: string | Date,
    durationMs: number,
    errorMessage?: string,
  ): Promise<boolean> {
    const startTimeFormatted = startTime instanceof Date ? startTime.toISOString() : startTime;
    const endTimeFormatted = endTime instanceof Date ? endTime.toISOString() : endTime;
    
    const durationSeconds = (durationMs / 1000).toFixed(2);
    const durationMinutes = (durationMs / 60000).toFixed(2);
    
    const statusEmoji = status === 'success' ? '✅' : '❌';
    const statusText = status === 'success' ? 'Успешно' : 'Ошибка';
    
    const message = `
${statusEmoji} <b>Обработка заявки завершена</b>

<b>ID объявления:</b> ${announceId}
<b>Статус:</b> ${statusText}
<b>Время начала:</b> ${this.formatDateTime(startTimeFormatted)}
<b>Время окончания:</b> ${this.formatDateTime(endTimeFormatted)}
<b>Длительность:</b> ${durationSeconds} сек (${durationMinutes} мин)
${errorMessage ? `\n<b>Ошибка:</b> ${this.escapeHtml(errorMessage)}` : ''}
    `.trim();

    return await this.sendMessage(message, 'HTML');
  }

  /**
   * Форматировать дату и время для отображения
   */
  private formatDateTime(isoString: string): string {
    try {
      const date = new Date(isoString);
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      const seconds = String(date.getSeconds()).padStart(2, '0');
      
      return `${day}.${month}.${year} ${hours}:${minutes}:${seconds}`;
    } catch (error) {
      return isoString;
    }
  }

  /**
   * Экранировать HTML символы
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
