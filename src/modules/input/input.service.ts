import { Injectable, Logger } from '@nestjs/common';
import * as robot from 'robotjs';

/**
 * Сервис для автоматического ввода данных через мышь и клавиатуру
 */
@Injectable()
export class InputService {
	private readonly logger = new Logger(InputService.name);

	/**
	 * Плавное перемещение мыши и клик по координатам
	 * @param x - координата X
	 * @param y - координата Y
	 * @param duration - длительность движения в мс (по умолчанию 200)
	 * @param smooth - использовать ли плавное движение (по умолчанию true)
	 */
	async clickAt(x: number, y: number, duration: number = 200, smooth: boolean = true): Promise<void> {
		this.logger.log(`Клик по координатам: (${x}, ${y}), длительность: ${duration}мс, плавно: ${smooth}`);

		try {
			if (smooth) {
				// Плавное перемещение мыши
				const currentPos = robot.getMousePos();
				const steps = Math.max(10, Math.floor(duration / 20)); // минимум 10 шагов
				const dx = (x - currentPos.x) / steps;
				const dy = (y - currentPos.y) / steps;

				for (let i = 0; i < steps; i++) {
					const newX = Math.round(currentPos.x + dx * (i + 1));
					const newY = Math.round(currentPos.y + dy * (i + 1));
					robot.moveMouse(newX, newY);
					await this.sleep(duration / steps);
				}
			} else {
				// Мгновенное перемещение
				robot.moveMouse(x, y);
			}

			// Клик
			robot.mouseClick();
			this.logger.log(`Клик выполнен`);
		} catch (error) {
			this.logger.error(`Ошибка при клике: ${(error as Error).message}`);
			throw error;
		}
	}
	
	
	getMousePosition() {
		const pos = robot.getMousePos();
		console.log(`Текущая позиция мыши: (${pos.x}, ${pos.y})`);
		return pos;
	}

	/**
	 * Очистка инпута (выделить все и удалить)
	 */
	clearInput(): void {
		this.logger.log('Очистка инпута');
		try {
			// Выделить все (Cmd+A на Mac, Ctrl+A на Windows/Linux)
			robot.keyTap('a', process.platform === 'darwin' ? 'command' : 'control');
			// Удалить
			robot.keyTap('delete');
		} catch (error) {
			this.logger.error(`Ошибка при очистке инпута: ${(error as Error).message}`);
			throw error;
		}
	}

	/**
	 * Ввод текста с задержкой между символами
	 * @param text - текст для ввода
	 * @param delay - задержка между символами в мс (по умолчанию 50)
	 */
	async typeText(text: string | number, delay: number = 50): Promise<void> {
		const textStr = String(text);
		this.logger.log(`Ввод текста: ${textStr}, задержка: ${delay}мс`);

		try {
			for (const char of textStr) {
				robot.typeString(char);
				if (delay > 0) {
					await this.sleep(delay);
				}
			}
			this.logger.log(`Текст введен`);
		} catch (error) {
			this.logger.error(`Ошибка при вводе текста: ${(error as Error).message}`);
			throw error;
		}
	}

	/**
	 * Вспомогательная функция для задержки
	 */
	private sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
}

