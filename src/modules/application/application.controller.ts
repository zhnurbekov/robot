import { Controller, Post, Get, Body, Param, Query, Logger } from '@nestjs/common';
import { ApplicationService } from './application.service';

@Controller('applications')
export class ApplicationController {
  private readonly logger = new Logger(ApplicationController.name);

  constructor(private readonly applicationService: ApplicationService) {}

  @Post('start')
  async submitApplication(@Body() applicationNumber: any) {
    const startTime = Date.now();
    this.logger.log('🚀 Запрос /start начат');
    
    try {
      await this.applicationService.submitApplication(applicationNumber.number);
      
      const duration = Date.now() - startTime;
      const durationSeconds = (duration / 1000).toFixed(2);
      const durationMs = duration;
      
      this.logger.log(`✅ Запрос /start выполнен успешно за ${durationSeconds} секунд (${durationMs} мс)`);
      console.log(`⏱️  Время выполнения запроса /start: ${durationSeconds} сек (${durationMs} мс)`);
      
      return {
        success: true,
        message: 'Запрос выполнен успешно',
        duration: {
          milliseconds: durationMs,
          seconds: parseFloat(durationSeconds),
          formatted: `${durationSeconds} сек`,
        },
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const durationSeconds = (duration / 1000).toFixed(2);
      const durationMs = duration;
      
      this.logger.error(`❌ Запрос /start завершился с ошибкой за ${durationSeconds} секунд (${durationMs} мс): ${(error as Error).message}`);
      console.error(`⏱️  Время выполнения запроса /start (с ошибкой): ${durationSeconds} сек (${durationMs} мс)`);
      
      return {
        success: false,
        message: (error as Error).message,
        duration: {
          milliseconds: durationMs,
          seconds: parseFloat(durationSeconds),
          formatted: `${durationSeconds} сек`,
        },
      };
    }
  }





  /**
   * Параллельная обработка документов (до 9)
   * POST /api/applications/:announceId/:applicationId/process-documents
   */
  @Post(':announceId/:applicationId/process-documents')
  async processDocumentsParallel(
    @Param('announceId') announceId: string,
    @Param('applicationId') applicationId: string,
    @Body() body: { docIds: string[] },
  ) {
    try {
      const { docIds } = body;

      if (!docIds || !Array.isArray(docIds)) {
        return {
          success: false,
          message: 'Необходимо передать массив docIds',
        };
      }

      if (docIds.length === 0) {
        return {
          success: false,
          message: 'Массив docIds не может быть пустым',
        };
      }

      if (docIds.length > 9) {
        return {
          success: false,
          message: 'Максимальное количество документов: 9',
        };
      }

      const result = await this.applicationService.processDocumentsParallel(
        announceId,
        applicationId,
        docIds,
      );

      return {
        success: result.success,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        message: (error as Error).message,
      };
    }
  }
}







