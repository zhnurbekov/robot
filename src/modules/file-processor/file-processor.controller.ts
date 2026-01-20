import { Controller, Post, Body, Get } from '@nestjs/common';
import { FileProcessorService, FileProcessingTask } from './file-processor.service';

@Controller('file-processor')
export class FileProcessorController {
  constructor(private readonly fileProcessorService: FileProcessorService) {}

  /**
   * Обработать один файл
   */
  @Post('process')
  async processFile(@Body() task: FileProcessingTask) {
    try {
      const result = await this.fileProcessorService.processFile(task);
      return {
        success: true,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        message: (error as Error).message,
      };
    }
  }

  /**
   * Параллельная обработка нескольких файлов (до 9)
   */
  @Post('process-parallel')
  async processFilesParallel(@Body() body: { tasks: FileProcessingTask[] }) {
    try {
      const { tasks } = body;
      
      if (!tasks || !Array.isArray(tasks)) {
        return {
          success: false,
          message: 'Необходимо передать массив tasks',
        };
      }

      if (tasks.length === 0) {
        return {
          success: false,
          message: 'Массив tasks не может быть пустым',
        };
      }

      if (tasks.length > 9) {
        return {
          success: false,
          message: 'Максимальное количество задач: 9',
        };
      }

      const results = await this.fileProcessorService.processFilesParallel(tasks);
      
      const successCount = results.filter(r => r.success).length;
      const failedCount = results.filter(r => !r.success).length;

      return {
        success: true,
        summary: {
          total: tasks.length,
          successful: successCount,
          failed: failedCount,
        },
        results,
      };
    } catch (error) {
      return {
        success: false,
        message: (error as Error).message,
      };
    }
  }

  /**
   * Очистить все временные файлы
   */
  @Post('cleanup')
  async cleanupTempFiles() {
    try {
      await this.fileProcessorService.cleanupAllTempFiles();
      return {
        success: true,
        message: 'Временные файлы очищены',
      };
    } catch (error) {
      return {
        success: false,
        message: (error as Error).message,
      };
    }
  }
}

