import InputService from './input-service.js';

/**
 * Тестовый файл для проверки работы сервиса
 */

const inputService = new InputService();

console.log('=== Тест сервиса ввода данных ===\n');

// Тест 1: Получение позиции мыши
console.log('Тест 1: Получение текущей позиции мыши');
console.log('Переместите мышь на инпут в модальном окне...');
console.log('Через 5 секунд будет показана текущая позиция\n');

setTimeout(() => {
  const pos = inputService.getMousePosition();
  console.log(`\nТекущие координаты: x=${pos.x}, y=${pos.y}`);
  console.log('Используйте эти координаты для ввода данных\n');
  
  // Тест 2: Ввод данных (раскомментируйте и укажите координаты)
  // console.log('Тест 2: Ввод данных');
  // inputService.inputAtCoordinates(pos.x, pos.y, 'Тестовый текст');
  
}, 5000);



