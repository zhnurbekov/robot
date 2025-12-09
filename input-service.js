import robot from 'robotjs';
import os from 'os';

/**
 * Сервис для автоматического ввода данных в инпут по координатам
 */
class InputService {
  constructor() {
    // Небольшая задержка для инициализации
    robot.setMouseDelay(2);
    robot.setKeyboardDelay(10);
    
    // Определяем платформу для правильной работы с горячими клавишами
    this.platform = os.platform();
    this.modifierKey = this.platform === 'darwin' ? 'command' : 'control';
  }

  /**
   * Плавно перемещает мышь к указанным координатам
   * @param {number} x - Координата X
   * @param {number} y - Координата Y
   * @param {number} steps - Количество шагов для плавного движения (по умолчанию 20)
   * @param {number} stepDelay - Задержка между шагами в миллисекундах (по умолчанию 10мс)
   * @returns {Promise} Промис, который выполняется после завершения движения
   */
  moveMouseSmooth(x, y, steps = 20, stepDelay = 10) {
    return new Promise((resolve) => {
      const currentPos = robot.getMousePos();
      const startX = currentPos.x;
      const startY = currentPos.y;
      const deltaX = x - startX;
      const deltaY = y - startY;
      
      console.log(`Плавно перемещаю мышь к координатам: (${x}, ${y})`);
      
      let currentStep = 0;
      
      const moveStep = () => {
        currentStep++;
        const progress = currentStep / steps;
        
        // Используем функцию плавности (ease-in-out)
        const easedProgress = progress < 0.5
          ? 2 * progress * progress
          : 1 - Math.pow(-2 * progress + 2, 2) / 2;
        
        const currentX = Math.round(startX + deltaX * easedProgress);
        const currentY = Math.round(startY + deltaY * easedProgress);
        
        robot.moveMouse(currentX, currentY);
        
        if (currentStep < steps) {
          setTimeout(moveStep, stepDelay);
        } else {
          // Убеждаемся, что мышь точно на нужных координатах
          robot.moveMouse(x, y);
          resolve();
        }
      };
      
      moveStep();
    });
  }

  /**
   * Кликает по указанным координатам
   * @param {number} x - Координата X
   * @param {number} y - Координата Y
   * @param {number} delay - Задержка после клика в миллисекундах (по умолчанию 200мс)
   * @param {boolean} smooth - Плавное движение мыши перед кликом (по умолчанию false)
   */
  async clickAt(x, y, delay = 200, smooth = false) {
    console.log(`Кликаю по координатам: (${x}, ${y})`);
    
    if (smooth) {
      await this.moveMouseSmooth(x, y);
    } else {
      robot.moveMouse(x, y);
    }
    
    robot.mouseClick();
    
    if (delay > 0) {
      robot.setMouseDelay(delay);
    }
    
    return this;
  }

  /**
   * Вводит текст в активное поле ввода
   * @param {string} text - Текст для ввода
   * @param {number} delay - Задержка между символами в миллисекундах (по умолчанию 50мс)
   */
  typeText(text, delay = 50) {
    console.log(`Ввожу текст: "${text}"`);
    
    if (delay > 0) {
      robot.setKeyboardDelay(delay);
    }
    
    robot.typeString(text);
    return this;
  }

  /**
   * Очищает поле ввода (выделяет все и удаляет)
   */
  clearInput() {
    console.log('Очищаю поле ввода');
    robot.keyTap('a', this.modifierKey); // Cmd+A на Mac, Ctrl+A на Windows/Linux
    robot.keyTap('delete');
    return this;
  }

  /**
   * Полный цикл: клик по координатам и ввод текста
   * @param {number} x - Координата X для клика
   * @param {number} y - Координата Y для клика
   * @param {string} text - Текст для ввода
   * @param {Object} options - Дополнительные опции
   * @param {boolean} options.clearBeforeInput - Очистить поле перед вводом (по умолчанию true)
   * @param {number} options.clickDelay - Задержка после клика в мс (по умолчанию 200)
   * @param {number} options.typeDelay - Задержка между символами в мс (по умолчанию 50)
   */
  inputAtCoordinates(x, y, text, options = {}) {
    const {
      clearBeforeInput = true,
      clickDelay = 200,
      typeDelay = 50
    } = options;

    console.log(`\n=== Начало ввода данных ===`);
    console.log(`Координаты: (${x}, ${y})`);
    console.log(`Текст: "${text}"`);
    
    // Кликаем по координатам
    this.clickAt(x, y, clickDelay);
    
    // Небольшая задержка для фокуса на поле
    robot.setMouseDelay(clickDelay);
    
    // Очищаем поле, если нужно
    if (clearBeforeInput) {
      this.clearInput();
      robot.setMouseDelay(100);
    }
    
    // Вводим текст
    this.typeText(text, typeDelay);
    
    console.log(`=== Ввод данных завершен ===\n`);
    
    return this;
  }

  /**
   * Получает текущую позицию курсора мыши
   * @returns {Object} Объект с координатами {x, y}
   */
  getMousePosition() {
    const pos = robot.getMousePos();
    console.log(`Текущая позиция мыши: (${pos.x}, ${pos.y})`);
    return pos;
  }

  /**
   * Устанавливает задержку для мыши
   * @param {number} delay - Задержка в миллисекундах
   */
  setMouseDelay(delay) {
    robot.setMouseDelay(delay);
    return this;
  }

  /**
   * Устанавливает задержку для клавиатуры
   * @param {number} delay - Задержка в миллисекундах
   */
  setKeyboardDelay(delay) {
    robot.setKeyboardDelay(delay);
    return this;
  }
}

export default InputService;

