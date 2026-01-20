import NcanodeService from './ncanode-service.js';

/**
 * Сервис для подачи заявок на портале
 */
class ApplicationService {
  constructor(config, httpClient, authService, ncanodeService) {
    this.config = config;
    this.httpClient = httpClient;
    this.authService = authService;
    this.ncanodeService = ncanodeService;
  }

  /**
   * Подать заявку
   * @param {Object} applicationData - Данные заявки
   */
  async submitApplication(applicationData) {
    try {
      console.log('[APPLICATION] Начало подачи заявки...');

      // Проверяем авторизацию
      if (!this.authService.getIsAuthenticated()) {
        console.log('[APPLICATION] Требуется авторизация...');
        await this.authService.login();
      }

      // Шаг 1: Получаем форму заявки
      const formData = await this.getApplicationForm(applicationData.lotId);
      console.log('[APPLICATION] Форма заявки получена');

      // Шаг 2: Заполняем данные заявки
      const filledForm = this.fillApplicationForm(formData, applicationData);
      console.log('[APPLICATION] Форма заполнена');

      // Шаг 3: Подписываем заявку через ncanode
      const signedApplication = await this.signApplication(filledForm);
      console.log('[APPLICATION] Заявка подписана');

      // Шаг 4: Отправляем заявку
      const result = await this.sendApplication(signedApplication);
      console.log('[APPLICATION] Заявка отправлена');

      return result;
    } catch (error) {
      console.error('[APPLICATION] Ошибка подачи заявки:', error.message);
      throw error;
    }
  }

  /**
   * Получить форму заявки
   */
  async getApplicationForm(lotId) {
    try {
      const response = await this.httpClient.get(`/api/lots/${lotId}/application/form`);
      return response.data;
    } catch (error) {
      console.error('[APPLICATION] Ошибка получения формы:', error.message);
      throw error;
    }
  }

  /**
   * Заполнить форму заявки
   */
  fillApplicationForm(formData, applicationData) {
    // Здесь логика заполнения формы на основе applicationData
    // Структура зависит от требований портала
    
    return {
      ...formData,
      ...applicationData,
      // Дополнительные поля
    };
  }

  /**
   * Подписать заявку через ncanode
   */
  async signApplication(applicationData) {
    try {
      // Преобразуем данные заявки в строку для подписи
      const dataToSign = JSON.stringify(applicationData);

      // Подписываем через ncanode
      const signature = await this.ncanodeService.sign(
        dataToSign,
        this.config.auth.certPath,
        this.config.auth.certPassword,
        true // с временной меткой
      );

      return {
        ...applicationData,
        signature: signature.signature,
        certificate: signature.certificate,
        tsp: signature.tsp,
      };
    } catch (error) {
      console.error('[APPLICATION] Ошибка подписи заявки:', error.message);
      throw error;
    }
  }

  /**
   * Отправить заявку на портал
   */
  async sendApplication(signedApplication) {
    try {
      const response = await this.httpClient.post('/api/applications/submit', signedApplication);
      
      if (response.status === 200 || response.status === 201) {
        return {
          success: true,
          applicationId: response.data.id || response.data.applicationId,
          message: 'Заявка успешно подана',
          data: response.data,
        };
      }

      throw new Error(`Неожиданный статус ответа: ${response.status}`);
    } catch (error) {
      if (error.response) {
        console.error('[APPLICATION] Ошибка ответа сервера:', error.response.data);
        return {
          success: false,
          error: error.response.data,
          status: error.response.status,
        };
      }
      throw error;
    }
  }

  /**
   * Получить список доступных лотов
   */
  async getAvailableLots(filters = {}) {
    try {
      const response = await this.httpClient.get('/api/lots', {
        params: filters,
      });
      return response.data;
    } catch (error) {
      console.error('[APPLICATION] Ошибка получения лотов:', error.message);
      throw error;
    }
  }

  /**
   * Получить статус заявки
   */
  async getApplicationStatus(applicationId) {
    try {
      const response = await this.httpClient.get(`/api/applications/${applicationId}/status`);
      return response.data;
    } catch (error) {
      console.error('[APPLICATION] Ошибка получения статуса:', error.message);
      throw error;
    }
  }
}

export default ApplicationService;



















