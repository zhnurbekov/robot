import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '../http/http.service';
import { AuthService } from '../auth/auth.service';
import * as cheerio from 'cheerio';

@Injectable()
export class AnnounceMonitorService {
  private readonly logger = new Logger(AnnounceMonitorService.name);
  private readonly announceId: string;
  private readonly baseUrl: string;

  constructor(
    private httpService: HttpService,
    private configService: ConfigService,
    @Inject(forwardRef(() => AuthService))
    private authService: AuthService,
  ) {
    this.announceId = this.configService.get<string>('ANNOUNCE_MONITOR_ID', '15850002');
    this.baseUrl = this.configService.get<string>('PORTAL_BASE_URL', 'https://v3bl.goszakup.gov.kz');
    
    // Устанавливаем callback для автоматической переавторизации при обнаружении истечения сессии
    this.httpService.setOnReauthRequiredCallback(async () => {
      this.logger.warn('🔄 Требуется переавторизация (обнаружено истечение сессии)');
      try {
        const success = await this.authService.login(true); // force=true для принудительной авторизации
        if (success) {
          this.logger.log('✅ Переавторизация выполнена успешно');
        } else {
          this.logger.error('❌ Переавторизация не удалась');
        }
        return success;
      } catch (error) {
        this.logger.error(`❌ Ошибка при переавторизации: ${(error as Error).message}`);
        return false;
      }
    });
    this.logger.log('Callback для автоматической переавторизации установлен');
  }

  /**
   * Проверка статуса объявления
   */
  async checkAnnounceStatus(): Promise<string | null> {
    try {
      const url = `${this.baseUrl}/ru/announce/index/${this.announceId}`;
      this.logger.debug(`Проверка статуса объявления ${this.announceId}: ${url}`);

      // Выполняем GET запрос
      const response = await this.httpService.get(url, {
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });

      if (!response || !response.data) {
        this.logger.warn('Пустой ответ от сервера');
        return null;
      }

      // Парсим HTML
      const html = typeof response.data === 'string' ? response.data : String(response.data);
      const $ = cheerio.load(html);

      // Логируем размер HTML для отладки
      this.logger.debug(`Размер HTML ответа: ${html.length} символов`);

      let status: string | null = null;

      // Метод 1: Ищем label с текстом "Статус объявления" и затем input в том же form-group
      const labels = $('label');
      this.logger.debug(`Найдено label элементов: ${labels.length}`);
      
      labels.each((index, element) => {
        const $label = $(element);
        const labelText = $label.text().trim();
        
        // Проверяем, содержит ли label текст "Статус объявления"
        if (labelText === 'Статус объявления' || labelText.includes('Статус объявления')) {
          this.logger.debug(`Найден label: "${labelText}"`);
          
          // Ищем родительский form-group
          const $formGroup = $label.closest('.form-group');
          if ($formGroup.length > 0) {
            // Ищем input с классом form-control внутри этого form-group
            const $input = $formGroup.find('input.form-control');
            if ($input.length > 0) {
              // Пробуем получить value из атрибута или через val()
              status = $input.attr('value') || ($input.val() as string) || null;
              if (status) {
                this.logger.log(`✅ Статус объявления найден: "${status}"`);
                return false; // Прерываем цикл
              }
            }
          }
        }
      });

      // Метод 2: Если не нашли, ищем через структуру: label -> div.col-sm-7 -> input
      if (!status) {
        $('.form-group').each((index, element) => {
          const $formGroup = $(element);
          const $label = $formGroup.find('label.control-label');
          const labelText = $label.text().trim();
          
          if (labelText === 'Статус объявления' || labelText.includes('Статус объявления')) {
            // Ищем input в div.col-sm-7
            const $input = $formGroup.find('div.col-sm-7 input.form-control');
            if ($input.length > 0) {
              status = $input.attr('value') || ($input.val() as string) || null;
              if (status) {
                this.logger.log(`✅ Статус объявления найден (метод 2): "${status}"`);
                return false;
              }
            }
          }
        });
      }

      // Метод 3: Ищем по regex в HTML напрямую (надежный метод)
      if (!status) {
        // Ищем паттерн: "Статус объявления" ... <input ... value="..." ...>
        const regex = /Статус объявления[\s\S]{0,300}?<input[^>]*class=["'][^"']*form-control[^"']*["'][^>]*value=["']([^"']+)["'][^>]*>/i;
        const match = html.match(regex);
        if (match && match[1]) {
          status = match[1];
          this.logger.log(`✅ Статус объявления найден (regex): "${status}"`);
        }
      }

      // Метод 4: Ищем все input с readonly и проверяем их родительские label
      if (!status) {
        const readonlyInputs = $('input[readonly]');
        this.logger.debug(`Найдено readonly input элементов: ${readonlyInputs.length}`);
        
        readonlyInputs.each((index, element) => {
          const $input = $(element);
          const $formGroup = $input.closest('.form-group');
          if ($formGroup.length > 0) {
            const $label = $formGroup.find('label');
            const labelText = $label.text().trim();
            if (labelText === 'Статус объявления' || labelText.includes('Статус объявления')) {
              status = $input.attr('value') || ($input.val() as string) || null;
              if (status) {
                this.logger.log(`✅ Статус объявления найден (readonly input): "${status}"`);
                return false;
              }
            }
          }
        });
      }

      if (!status) {
        this.logger.warn('❌ Статус объявления не найден в HTML');
        // Логируем часть HTML вокруг "Статус объявления" для отладки
        const statusIndex = html.indexOf('Статус объявления');
        if (statusIndex !== -1) {
          const htmlPreview = html.substring(Math.max(0, statusIndex - 200), Math.min(html.length, statusIndex + 1000));
          this.logger.debug(`HTML вокруг "Статус объявления":\n${htmlPreview}`);
        }
      }

      return status;
    } catch (error) {
      this.logger.error(`Ошибка при проверке статуса объявления: ${error.message}`);
      if (error.stack) {
        this.logger.debug(error.stack);
      }
      return null;
    }
  }

  /**
   * Получить ID объявления для мониторинга
   */
  getAnnounceId(): string {
    return this.announceId;
  }

  /**
   * Извлечь номер лота из HTML страницы объявления
   */
  async getLotNumber(): Promise<string | null> {
    try {
      const url = `${this.baseUrl}/ru/announce/index/${this.announceId}`;
      this.logger.debug(`Получение номера лота для объявления ${this.announceId}: ${url}`);

      // Выполняем GET запрос
      const response = await this.httpService.get(url, {
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });

      if (!response || !response.data) {
        this.logger.warn('Пустой ответ от сервера при получении номера лота');
        return null;
      }

      // Парсим HTML
      const html = typeof response.data === 'string' ? response.data : String(response.data);
      const $ = cheerio.load(html);

      // Метод 1: Ищем "Номер объявления" в form-group
      let lotNumber: string | null = null;

      $('.form-group').each((index, element) => {
        const $formGroup = $(element);
        const $label = $formGroup.find('label.control-label');
        const labelText = $label.text().trim();
        
        if (labelText === 'Номер объявления' || labelText.includes('Номер объявления')) {
          // Ищем input в div.col-sm-7
          const $input = $formGroup.find('div.col-sm-7 input.form-control');
          if ($input.length > 0) {
            lotNumber = $input.attr('value') || ($input.val() as string) || null;
            if (lotNumber) {
              this.logger.log(`✅ Номер лота найден: "${lotNumber}"`);
              return false; // Прерываем цикл
            }
          }
        }
      });

      // Метод 2: Ищем в заголовке панели
      if (!lotNumber) {
        const panelHeading = $('.panel-heading h4').text().trim();
        const match = panelHeading.match(/№\s*(\d+[-\d]*)/i) || panelHeading.match(/объявлени[ея]\s*№\s*(\d+[-\d]*)/i);
        if (match && match[1]) {
          lotNumber = match[1];
          this.logger.log(`✅ Номер лота найден в заголовке: "${lotNumber}"`);
        }
      }

      // Метод 3: Ищем через regex в HTML
      if (!lotNumber) {
        const regex = /Номер объявления[\s\S]{0,300}?<input[^>]*value=["']([^"']+)["'][^>]*>/i;
        const match = html.match(regex);
        if (match && match[1]) {
          lotNumber = match[1];
          this.logger.log(`✅ Номер лота найден (regex): "${lotNumber}"`);
        }
      }

      if (!lotNumber) {
        this.logger.warn('❌ Номер лота не найден в HTML');
      }

      return lotNumber;
    } catch (error) {
      this.logger.error(`Ошибка при получении номера лота: ${error.message}`);
      if (error.stack) {
        this.logger.debug(error.stack);
      }
      return null;
    }
  }
}

