import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { PortalService } from '../portal/portal.service';

@Injectable()
export class CabinetCronService {
  private readonly logger = new Logger(CabinetCronService.name);

  constructor(
    @Inject(forwardRef(() => AuthService))
    private authService: AuthService,
    private portalService: PortalService,
  ) {}

  /**
   * Выполнить поочерёдно два POST-запроса на портал (раз в час):
   * 1) tax_debts — «Получить новые сведения»
   * 2) permits — «Получить разрешение» с заданными фильтрами
   */
  async runHourlyRequests(): Promise<void> {
    const taskId = 'cabinet-cron-hourly';
    this.logger.log(`[${taskId}] Запуск почасовых запросов кабинета...`);

    try {
      await this.authService.login();
    } catch (error) {
      this.logger.error(`[${taskId}] Ошибка авторизации: ${(error as Error).message}`);
      throw error;
    }

    try {
      await this.sendTaxDebtsRequest();
      await this.sendPermitsRequest();
      this.logger.log(`[${taskId}] Оба запроса выполнены`);
    } catch (error) {
      this.logger.error(`[${taskId}] Ошибка при выполнении запросов: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * POST /ru/cabinet/tax_debts
   * Form: send_request=Получить новые сведения
   */
  private async sendTaxDebtsRequest(): Promise<void> {
    const url = '/ru/cabinet/tax_debts';
    this.logger.log(`[cabinet-cron] Отправка POST ${url} (Получить новые сведения)...`);

    const response = await this.portalService.request({
      url,
      method: 'POST',
      isFormData: true,
      data: {
        send_request: 'Получить новые сведения',
      },
      additionalHeaders: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (!response.success) {
      this.logger.warn(`[cabinet-cron] tax_debts: запрос завершился неуспешно, статус: ${response.status}`);
    } else {
      this.logger.log(`[cabinet-cron] tax_debts: OK, статус ${response.status}`);
    }
  }

  /**
   * POST /ru/cabinet/permits
   * Form: filter[nikad]=&filter[date_issue]=&request[type]=1&request[text]=KZ35VWC00252553&request[date_issue]=&get_permit=Получить разрешение &type=permit
   */
  private async sendPermitsRequest(): Promise<void> {
    const url = '/ru/cabinet/permits';
    this.logger.log(`[cabinet-cron] Отправка POST ${url} (Получить разрешение)...`);

    const response = await this.portalService.request({
      url,
      method: 'POST',
      isFormData: true,
      data: {
        'filter[nikad]': '',
        'filter[date_issue]': '',
        'request[type]': '1',
        'request[text]': 'KZ35VWC00252553',
        'request[date_issue]': '',
        get_permit: 'Получить разрешение ',
        type: 'permit',
      },
      additionalHeaders: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (!response.success) {
      this.logger.warn(`[cabinet-cron] permits: запрос завершился неуспешно, статус: ${response.status}`);
    } else {
      this.logger.log(`[cabinet-cron] permits: OK, статус ${response.status}`);
    }
  }
}
