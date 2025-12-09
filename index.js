import InputService from './input-service.js';

/**
 * Пример использования сервиса для ввода данных в модальное окно
 * 
 * ВАЖНО: Перед запуском убедитесь, что:
 * 1. Модальное окно уже открыто
 * 2. Вы знаете точные координаты инпута
 * 3. Инпут виден и доступен для взаимодействия
 */

// Создаем экземпляр сервиса
const inputService = new InputService();

// Пример 1: Простой ввод данных по координатам
function example1() {
  console.log('Пример 1: Простой ввод данных');
  
  // Координаты инпута (замените на ваши координаты)
  const x = 633;
  const y = 147;
  
  // Текст для ввода
  const text = 'Тестовый текст';
  
  // Вводим данные
  inputService.inputAtCoordinates(x, y, text);
}

// Пример 2: Ввод с дополнительными опциями
function example2() {
  console.log('Пример 2: Ввод с опциями');
  
  const x = 380;
  const y = 154;
  const text = 'Другой текст';
  
  inputService.inputAtCoordinates(x, y, text, {
    clearBeforeInput: true,  // Очистить поле перед вводом
    clickDelay: 300,         // Задержка после клика 300мс
    typeDelay: 30            // Задержка между символами 30мс
  });
}

// Пример 3: Пошаговый ввод с плавным движением мыши
async function example3() {
  console.log('Пример 3: Пошаговый ввод с плавным движением мыши');
  
  const x = 790;
  const y = 322;
  
  // Плавно перемещаем мышь и кликаем
  await inputService.clickAt(x, y, 200, true);
  
  // Ждем немного
  setTimeout(() => {
    // Очищаем
    inputService.clearInput();
    
    // Ждем еще немного
    setTimeout(() => {
      // Вводим текст
      inputService.typeText('Пошаговый ввод', 50);
    }, 100);
  }, 200);
}

// Пример 4: Получение текущей позиции мыши (для определения координат)
function example4() {
  console.log('Пример 4: Получение позиции мыши');
  console.log('Переместите мышь на нужное место и подождите 3 секунды...');
  
  setTimeout(() => {
    const pos = inputService.getMousePosition();
    console.log(`Используйте эти координаты: x=${pos.x}, y=${pos.y}`);
  }, 3000);
}

// Главная функция
function main() {
  console.log('=== Сервис автоматического ввода данных ===\n');
  
  // Раскомментируйте нужный пример:
  
  // example1();      // Простой ввод
  // example2();      // Ввод с опциями
  example3();      // Пошаговый ввод
  // example1();         // Получение координат мыши
  
  // Или используйте свой код:
  // inputService.inputAtCoordinates(500, 300, 'Ваш текст');
}

// Запускаем
main();
