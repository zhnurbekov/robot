// Полифиллы для Node.js 16 (ReadableStream и Blob)
// Этот файл должен быть загружен первым через --require

// Полифилл для ReadableStream из web-streams-polyfill
if (typeof globalThis.ReadableStream === 'undefined') {
  try {
    var streams = require('web-streams-polyfill/ponyfill/es2018');
    globalThis.ReadableStream = streams.ReadableStream;
  } catch (error) {
    // Fallback на stream/web если доступен
    try {
      var streamWeb = require('stream/web');
      globalThis.ReadableStream = streamWeb.ReadableStream;
    } catch (e) {
      console.warn('Не удалось загрузить ReadableStream:', error);
    }
  }
}

// Полифилл для Blob
if (typeof globalThis.Blob === 'undefined') {
  try {
    // В Node.js 16 Blob может быть доступен через buffer (в некоторых версиях)
    const buffer = require('buffer');
    if (buffer.Blob) {
      globalThis.Blob = buffer.Blob;
    } else {
      throw new Error('Blob not found in buffer');
    }
  } catch (error) {
    // Используем node-fetch Blob если доступен, иначе просто предупреждение
    try {
      var nodeFetch = require('node-fetch');
      globalThis.Blob = nodeFetch.Blob;
    } catch (e) {
      // Если ничего не помогло, создаем минимальный полифилл
      // Но лучше установить node-fetch или использовать версию Node.js с Blob
      console.warn('Blob не найден. Некоторые функции могут не работать. Рекомендуется использовать Node.js 18+ или установить node-fetch.');
    }
  }
}
