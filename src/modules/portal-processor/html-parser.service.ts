import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';

@Injectable()
export class HtmlParserService {
  private readonly logger = new Logger(HtmlParserService.name);

  /**
   * Очистка текста от HTML тегов и лишних пробелов
   */
  cleanText(text: string): string {
    if (!text) return '';
    return text
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, '') // Убираем теги
      .replace(/\s+/g, ' ')     // Убираем лишние пробелы
      .trim();
  }

  /**
   * Парсинг таблицы объявлений из HTML
   */
  parseAnnouncementsTable(html: string): any[] {
    const announcements: any[] = [];
    
    
    try {
      // Находим тело таблицы id="search-result"
      // Сначала ищем начало таблицы с id="search-result"
      let tableStartMatch = html.match(/<table[^>]*id=["']search-result["'][^>]*>/i);
      
      if (!tableStartMatch) {
        // Пробуем с одинарными кавычками
        tableStartMatch = html.match(/<table[^>]*id=['"]search-result['"][^>]*>/i);
      }
      
      let tableMatch = null;
      
      if (tableStartMatch) {
        // Нашли начало таблицы, теперь ищем её конец
        const tableStartIndex = html.indexOf(tableStartMatch[0]);
        let depth = 0;
        let inTable = false;
        let tableEndIndex = -1;
        
        for (let i = tableStartIndex; i < html.length; i++) {
          const substr = html.substring(i, i + 7);
          if (substr === '<table') {
            depth++;
            inTable = true;
          } else if (substr === '</table') {
            depth--;
            if (depth === 0 && inTable) {
              tableEndIndex = html.indexOf('>', i + 7);
              if (tableEndIndex !== -1) {
                tableEndIndex++;
                break;
              }
            }
          }
        }
        
        if (tableEndIndex !== -1) {
          const tableContent = html.substring(tableStartIndex, tableEndIndex);
          tableMatch = [tableContent, tableContent.substring(tableStartMatch[0].length, tableContent.length - 8)];
        }
      }
      
      // Если не нашли через поиск начала/конца, пробуем регулярное выражение
      if (!tableMatch) {
        tableMatch = html.match(/<table[^>]*id=["']search-result["'][^>]*>([\s\S]*?)<\/table>/i);
      }
      
      if (!tableMatch) {
        // Улучшенная диагностика: проверяем альтернативные варианты
        const hasTable = html.includes('<table');
        const hasSearchResult = html.includes('search-result');
        const hasTbody = html.includes('<tbody>');
        
        // Пробуем найти таблицу с id="search-result" более точно
        const searchResultTableMatch = html.match(/<table[^>]*id[^>]*search-result[^>]*>/i);
        
        // Пробуем найти любую таблицу для диагностики
        const anyTableMatch = html.match(/<table[^>]*>([\s\S]{0,500})<\/table>/i);
        
        this.logger.warn('Таблица объявлений (id="search-result") не найдена в HTML');
        this.logger.debug(`Диагностика: hasTable=${hasTable}, hasSearchResult=${hasSearchResult}, hasTbody=${hasTbody}`);
        
        if (searchResultTableMatch) {
          this.logger.debug(`Найдена таблица с search-result в атрибутах: ${searchResultTableMatch[0].substring(0, 300)}`);
        }
        
        if (anyTableMatch) {
          this.logger.debug(`Найдена таблица без id="search-result": ${anyTableMatch[0].substring(0, 300)}`);
        }
        
        // Проверяем, может быть это страница без результатов поиска
        const hasNoResults = html.includes('нет результатов') || html.includes('результатов не найдено') || 
                             html.includes('не найдено') || html.includes('No results');
        if (hasNoResults) {
          this.logger.debug('Похоже, что результатов поиска нет на странице');
        }
        
        return [];
      }
      
      const tableContent = tableMatch[1];
      const tbodyMatch = tableContent.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
      
      if (!tbodyMatch) {
        return [];
      }
      
      const tbodyContent = tbodyMatch[1];
      
      // Разбиваем на строки
      const rows = tbodyContent.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
      if (!rows) {
        return [];
      }
      
      for (const row of rows) {
        // Извлекаем ячейки
        const cells = row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
        if (cells && cells.length >= 7) {
          
          // Ячейка 0: Номер (<strong>15800854-1</strong>)
          const numberMatch = cells[0].match(/<strong>(.*?)<\/strong>/i);
          const number = numberMatch ? this.cleanText(numberMatch[1]) : this.cleanText(cells[0]);
          
          // Ячейка 1: Наименование, Ссылка, Организатор
          const nameCell = cells[1];
          // Используем [\s\S]*? вместо .*? для захвата многострочного текста
          const linkMatch = nameCell.match(/href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
          const link = linkMatch ? linkMatch[1] : '';
          const nameRaw = linkMatch ? linkMatch[2] : '';
          const name = this.cleanText(nameRaw);
          
          const organizerMatch = nameCell.match(/Организатор:<\/b>([\s\S]*?)<br>/i) || nameCell.match(/Организатор:<\/b>([\s\S]*?)<\/small>/i);
          const organizer = organizerMatch ? this.cleanText(organizerMatch[1]) : '';
          
          // Ячейка 2: Способ
          const method = this.cleanText(cells[2]);
          
          // Ячейка 3: Начало приема
          const startDateRaw = cells[3].replace(/<br\s*\/?>/gi, ' ');
          const startDate = this.cleanText(startDateRaw);
          
          // Ячейка 4: Окончание приема
          const endDateRaw = cells[4].replace(/<br\s*\/?>/gi, ' ');
          const endDate = this.cleanText(endDateRaw);
          
          // Ячейка 5: Сумма
          const amountMatch = cells[5].match(/<strong>(.*?)<\/strong>/i);
          const amountStr = amountMatch ? this.cleanText(amountMatch[1]) : this.cleanText(cells[5]);
          // Преобразуем сумму в число (убираем пробелы и меняем запятую на точку если нужно)
          const amount = parseFloat(amountStr.replace(/\s/g, '').replace(',', '.'));
          
          // Ячейка 6: Статус
          const status = this.cleanText(cells[6]);
          
          announcements.push({
            number,
            name,
            link,
            organizer,
            method,
            startDate,
            endDate,
            amount,
            status,
            rawData: {
              number: this.cleanText(cells[0]),
              amountStr
            }
          });
        }
      }
    } catch (error) {
      this.logger.error(`Ошибка парсинга таблицы объявлений: ${(error as Error).message}`);
    }
    
    return announcements;
  }

  /**
   * Извлечь номер заявки из HTML
   */
  extractApplicationNumber(html: string): string | null {
    try {
      const patterns = [
        /<label[^>]*>Номер\s+заявки<\/label>[\s\S]{0,500}?<input[^>]*value\s*=\s*["']([0-9]+)["']/i,
        /Просмотр\s+заявки\s*№\s*([0-9]+)/i,
        /<h4[^>]*>Просмотр\s+заявки\s*№\s*([0-9]+)/i,
        /Номер\s+заявки[\s\S]{0,300}?<input[^>]*value\s*=\s*["']([0-9]+)["']/i,
        /Номер\s+заявки[^>]*>[\s\S]{0,200}?value\s*=\s*["']([0-9]+)["']/i,
        /Номер\s+заявки[^0-9]*([0-9]{6,})/i,
      ];

      for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match && match[1]) {
          const number = match[1].trim();
          if (number && /^[0-9]+$/.test(number)) {
            return number;
          }
        }
      }

      // Дополнительная попытка: ищем любые числа после "заявки"
      const fallbackPattern = /заявки[^0-9]*([0-9]{6,})/i;
      const fallbackMatch = html.match(fallbackPattern);
      if (fallbackMatch && fallbackMatch[1]) {
        const number = fallbackMatch[1].trim();
        return number;
      }

      return null;
    } catch (error) {
      this.logger.error(`Ошибка извлечения номера заявки: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Извлечь ID созданной заявки из HTML
   */
  extractCreatedApplicationId(html: string): string | null {
    try {
      // Ищем var application_id = 12345;
      const appIdMatch = html.match(/var\s+application_id\s*=\s*(\d+);/i);
      if (appIdMatch && appIdMatch[1]) {
        return appIdMatch[1];
      }

      // Ищем window.url_params = ["123", "456"]; - второй параметр обычно application_id
      const urlParamsMatch = html.match(/window\.url_params\s*=\s*\["[^"]*",\s*"(\d+)"\];/i);
      if (urlParamsMatch && urlParamsMatch[1]) {
        return urlParamsMatch[1];
      }
      
      // Ищем в form action URL: /ru/application/lots/15812194/68038073
      const formActionMatch = html.match(/action="[^"]*\/application\/lots\/\d+\/(\d+)"/i);
      if (formActionMatch && formActionMatch[1]) {
        return formActionMatch[1];
      }

      return null;
    } catch (error) {
      this.logger.error(`Ошибка извлечения ID созданной заявки: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Извлечь ID лотов из HTML страницы выбора лотов
   */
  extractLotIds(html: string): string[] {
    const lotIds: string[] = [];
    try {
      // Ищем <input type="checkbox" name="selectLots[]" value="123456">
      const regex = /<input[^>]*name=["']selectLots\[\]["'][^>]*value=["'](\d+)["'][^>]*>/gi;
      let match;
      while ((match = regex.exec(html)) !== null) {
        if (match[1]) {
          lotIds.push(match[1]);
        }
      }
      
      this.logger.log(`Найдено лотов для выбора: ${lotIds.length}`);
      return lotIds;
    } catch (error) {
      this.logger.error(`Ошибка извлечения ID лотов: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * Извлечь идентификатор файла (data-file-identifier) из HTML
   */
  extractFileIdentifier(html: string): string | null {
    try {
      // Ищем атрибут data-file-identifier="12345"
      const match = html.match(/data-file-identifier=["']([^"']+)["']/i);
      if (match && match[1]) {
        return match[1];
      }
      return null;
    } catch (error) {
      this.logger.error(`Ошибка извлечения идентификатора файла: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Извлечь from_lot (data-id из radio input) из HTML
   */
  extractFromLot(html: string): string | null {
    try {
      // Ищем <input type="radio" name="from_lot" value="..."> и затем data-id из следующего <a>
      // Паттерн: <tr>...<input type="radio" name="from_lot" value="...">...<a ... data-id="...">
      const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi);
      if (!rows) {
        return null;
      }

      for (const row of rows) {
        // Проверяем, есть ли radio input с name="from_lot"
        if (row.includes('type="radio"') && row.includes('name="from_lot"')) {
          // Извлекаем data-id из <a> в этой строке
          const dataIdMatch = row.match(/data-id=["']([^"']+)["']/i);
          if (dataIdMatch && dataIdMatch[1]) {
            return dataIdMatch[1];
          }
          // Если data-id не найден, пробуем извлечь value из input
          const valueMatch = row.match(/<input[^>]*name=["']from_lot["'][^>]*value=["']([^"']+)["']/i);
          if (valueMatch && valueMatch[1]) {
            return valueMatch[1];
          }
        }
      }

      return null;
    } catch (error) {
      this.logger.error(`Ошибка извлечения from_lot: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Извлечь to_lot[] (data-id из checkbox input) из HTML
   */
  extractToLot(html: string): string | null {
    try {
      // Ищем <input type="checkbox" name="to_lot[]" value="..."> и затем data-id из следующего <a>
      const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi);
      if (!rows) {
        return null;
      }

      for (const row of rows) {
        // Проверяем, есть ли checkbox input с name="to_lot[]"
        if (row.includes('type="checkbox"') && row.includes('name="to_lot[]"')) {
          // Извлекаем data-id из <a> в этой строке
          const dataIdMatch = row.match(/data-id=["']([^"']+)["']/i);
          if (dataIdMatch && dataIdMatch[1]) {
            return dataIdMatch[1];
          }
          // Если data-id не найден, пробуем извлечь value из input
          const valueMatch = row.match(/<input[^>]*name=["']to_lot\[\]["'][^>]*value=["']([^"']+)["']/i);
          if (valueMatch && valueMatch[1]) {
            return valueMatch[1];
          }
        }
      }

      return null;
    } catch (error) {
      this.logger.error(`Ошибка извлечения to_lot: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Извлечь href из ссылки с текстом "Добавить"
   */
  extractAddButtonHref(html: string): string | null {
    try {
      // Сначала пробуем более точный паттерн: ищем ссылку, которая содержит текст "Добавить"
      // Учитываем, что между тегами могут быть пробелы и переносы строк
      const directPattern = /<a[^>]*href=["']([^"']+)["'][^>]*>[\s\n\r]*Добавить[\s\n\r]*<\/a>/i;
      const directMatch = html.match(directPattern);
      if (directMatch && directMatch[1]) {
        const href = directMatch[1];
        this.logger.debug(`Найдена ссылка "Добавить" через прямой паттерн: ${href}`);
        // Если href абсолютный, извлекаем путь
        if (href.startsWith('http')) {
          try {
            const url = new URL(href);
            return url.pathname + url.search;
          } catch (e) {
            // Если не удалось распарсить URL, возвращаем как есть
            return href;
          }
        }
        return href;
      }

      // Альтернативный подход: ищем все ссылки и проверяем их текст
      const linkPattern = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let linkMatch;
      
      while ((linkMatch = linkPattern.exec(html)) !== null) {
        const href = linkMatch[1];
        const linkContent = linkMatch[2];
        
        // Очищаем текст от HTML тегов и проверяем наличие "Добавить"
        const cleanLinkText = this.cleanText(linkContent);
        
        if (cleanLinkText && cleanLinkText.trim() === 'Добавить') {
          this.logger.debug(`Найдена ссылка "Добавить" через перебор: ${href}`);
          // Если href абсолютный, извлекаем путь
          if (href.startsWith('http')) {
            try {
              const url = new URL(href);
              return url.pathname + url.search;
            } catch (e) {
              // Если не удалось распарсить URL, возвращаем как есть
              return href;
            }
          }
          return href;
        }
      }

      // Если ничего не найдено, пробуем более широкий поиск
      this.logger.warn('Не удалось найти ссылку "Добавить" стандартными методами, пробуем расширенный поиск...');
      const widePattern = /<a[^>]*href=["']([^"']+)["'][^>]*>[\s\S]{0,100}Добавить[\s\S]{0,100}<\/a>/i;
      const wideMatch = html.match(widePattern);
      if (wideMatch && wideMatch[1]) {
        const href = wideMatch[1];
        this.logger.debug(`Найдена ссылка "Добавить" через расширенный поиск: ${href}`);
        if (href.startsWith('http')) {
          try {
            const url = new URL(href);
            return url.pathname + url.search;
          } catch (e) {
            return href;
          }
        }
        return href;
      }

      this.logger.warn('Ссылка "Добавить" не найдена в HTML');
      return null;
    } catch (error) {
      this.logger.error(`Ошибка извлечения href кнопки "Добавить": ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Извлечь value из первого checkbox с name="permit_select[]" в первой строке таблицы
   */
  extractFirstPermitSelectValue(html: string): string | null {
    try {
      // Сначала пробуем найти все checkbox с name="permit_select[]" в документе
      const allCheckboxes = html.matchAll(/<input[^>]*type=["']checkbox["'][^>]*name=["']permit_select\[\]["'][^>]*value=["']([^"']+)["']/gi);
      const checkboxValues: string[] = [];
      
      for (const match of allCheckboxes) {
        if (match[1]) {
          checkboxValues.push(match[1]);
        }
      }
      
      if (checkboxValues.length > 0) {
        this.logger.debug(`Найдено checkbox permit_select[]: ${checkboxValues.length}, первый value: ${checkboxValues[0]}`);
        return checkboxValues[0];
      }
      
      // Если не нашли через прямой поиск, пробуем через таблицу
      // Ищем tbody с таблицей
      const tbodyMatch = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
      if (!tbodyMatch) {
        this.logger.warn('Таблица (tbody) не найдена в HTML для permit_select[]');
        // Пробуем найти checkbox вне таблицы
        const checkboxMatch = html.match(/<input[^>]*name=["']permit_select\[\]["'][^>]*value=["']([^"']+)["']/i);
        if (checkboxMatch && checkboxMatch[1]) {
          this.logger.debug(`Найден checkbox permit_select[] вне таблицы: ${checkboxMatch[1]}`);
          return checkboxMatch[1];
        }
        return null;
      }

      const tbodyContent = tbodyMatch[1];
      
      // Ищем первую строку <tr>
      const firstRowMatch = tbodyContent.match(/<tr[^>]*>([\s\S]*?)<\/tr>/i);
      if (!firstRowMatch) {
        this.logger.warn('Первая строка таблицы не найдена для permit_select[]');
        return null;
      }

      const firstRow = firstRowMatch[1];
      
      // Ищем checkbox с name="permit_select[]" и извлекаем value
      // Более гибкий паттерн: разрешаем пробелы и разные варианты кавычек
      const checkboxMatch = firstRow.match(/<input[^>]*type=["']checkbox["'][^>]*name=["']permit_select\[\]["'][^>]*value=["']([^"']+)["']/i);
      if (checkboxMatch && checkboxMatch[1]) {
        this.logger.debug(`Найден checkbox permit_select[] в первой строке: ${checkboxMatch[1]}`);
        return checkboxMatch[1];
      }
      
      // Альтернативный паттерн: ищем name="permit_select[]" без строгого порядка атрибутов
      const altMatch = firstRow.match(/<input[^>]*name=["']permit_select\[\]["'][^>]*value=["']([^"']+)["']/i);
      if (altMatch && altMatch[1]) {
        this.logger.debug(`Найден checkbox permit_select[] альтернативным методом: ${altMatch[1]}`);
        return altMatch[1];
      }
      
      // Пробуем найти любой checkbox в первой строке
      const anyCheckboxMatch = firstRow.match(/<input[^>]*type=["']checkbox["'][^>]*value=["']([^"']+)["']/i);
      if (anyCheckboxMatch && anyCheckboxMatch[1]) {
        this.logger.warn(`Найден checkbox в первой строке, но без name="permit_select[]": ${anyCheckboxMatch[1]}`);
        // Возвращаем его как fallback
        return anyCheckboxMatch[1];
      }

      this.logger.warn('Не удалось найти checkbox permit_select[] в первой строке таблицы');
      return null;
    } catch (error) {
      this.logger.error(`Ошибка извлечения value из permit_select[]: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Извлечь href из ссылки с текстом "Просмотреть"
   */
  extractViewButtonHref(html: string): string | null {
    try {
      // Ищем ссылку с текстом "Просмотреть" и классом btn btn-sm btn-primary
      const pattern = /<a[^>]*class=["'][^"']*btn[^"']*btn-sm[^"']*btn-primary[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>[\s\S]*?Просмотреть[\s\S]*?<\/a>/i;
      const match = html.match(pattern);
      if (match && match[1]) {
        const href = match[1];
        // Если href абсолютный, извлекаем путь
        if (href.startsWith('http')) {
          try {
            const url = new URL(href);
            return url.pathname + url.search;
          } catch (e) {
            return href;
          }
        }
        return href;
      }

      // Альтернативный поиск: просто ищем ссылку с текстом "Просмотреть"
      const linkPattern = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let linkMatch;
      
      while ((linkMatch = linkPattern.exec(html)) !== null) {
        const href = linkMatch[1];
        const linkContent = linkMatch[2];
        const cleanLinkText = this.cleanText(linkContent);
        
        if (cleanLinkText && cleanLinkText.includes('Просмотреть')) {
          if (href.startsWith('http')) {
            try {
              const url = new URL(href);
              return url.pathname + url.search;
            } catch (e) {
              return href;
            }
          }
          return href;
        }
      }

      return null;
    } catch (error) {
      this.logger.error(`Ошибка извлечения href из ссылки "Просмотреть": ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Извлечь data-url и data-file-identifier из кнопки подписи в блоке add_signature_block
   */
  extractSignatureButtonData(html: string): { dataUrl: string | null; fileIdentifier: string | null } {
    try {
      // Ищем блок add_signature_block
      const blockMatch = html.match(/<div[^>]*class=["'][^"']*add_signature_block[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
      if (!blockMatch) {
        this.logger.warn('Блок add_signature_block не найден в HTML');
        return { dataUrl: null, fileIdentifier: null };
      }

      const blockContent = blockMatch[1];
      
      // Извлекаем data-url
      const dataUrlMatch = blockContent.match(/data-url=["']([^"']+)["']/i);
      const dataUrl = dataUrlMatch && dataUrlMatch[1] ? dataUrlMatch[1] : null;

      // Извлекаем data-file-identifier
      const dataIdMatch = blockContent.match(/data-file-identifier=["']([^"']+)["']/i);
      const fileIdentifier = dataIdMatch && dataIdMatch[1] ? dataIdMatch[1] : null;

      return { dataUrl, fileIdentifier };
    } catch (error) {
      this.logger.error(`Ошибка извлечения data-url и data-file-identifier: ${(error as Error).message}`);
      return { dataUrl: null, fileIdentifier: null };
    }
  }

  /**
   * Извлечь все data-url и data-file-identifier из таблицы используя cheerio
   * Возвращает массив объектов с dataUrl и fileIdentifier
   */
  extractAllSignatureButtonData(html: string): Array<{ dataUrl: string; fileIdentifier: string }> {
    const results: Array<{ dataUrl: string; fileIdentifier: string }> = [];
    const foundIds = new Set<string>(); // Для избежания дубликатов
    
    try {
      const $ = cheerio.load(html);
      
      // Метод 1: Ищем в блоках add_signature_block (приоритетный метод)
      this.logger.debug('Поиск кнопок в блоках add_signature_block...');
      $('.add_signature_block').each((i, elem) => {
        const $block = $(elem);
        
        // Ищем кнопки внутри блока с атрибутами data-url и data-file-identifier
        $block.find('button[data-url][data-file-identifier]').each((j, btn) => {
          const $btn = $(btn);
          const dataUrl = $btn.attr('data-url')?.trim();
          const fileIdentifier = $btn.attr('data-file-identifier')?.trim();
          
          if (dataUrl && fileIdentifier && !foundIds.has(fileIdentifier)) {
            foundIds.add(fileIdentifier);
            results.push({ 
              dataUrl, 
              fileIdentifier 
            });
            this.logger.debug(`Найдена кнопка в блоке add_signature_block: dataUrl="${dataUrl}", fileIdentifier="${fileIdentifier}"`);
          }
        });
      });

      // Метод 2: Ищем все кнопки с классом btn-add-signature (включая те, что могут быть вне блоков)
      this.logger.debug('Поиск кнопок с классом btn-add-signature...');
      $('button.btn-add-signature[data-url][data-file-identifier]').each((i, elem) => {
        const $button = $(elem);
        const dataUrl = $button.attr('data-url')?.trim();
        const fileIdentifier = $button.attr('data-file-identifier')?.trim();
        
        if (dataUrl && fileIdentifier && !foundIds.has(fileIdentifier)) {
          foundIds.add(fileIdentifier);
          results.push({ 
            dataUrl, 
            fileIdentifier 
          });
          this.logger.debug(`Найдена кнопка btn-add-signature: dataUrl="${dataUrl}", fileIdentifier="${fileIdentifier}"`);
        }
      });

      // Метод 3: Ищем кнопки с классом btn-success, которые содержат нужные атрибуты
      this.logger.debug('Поиск кнопок btn-success с data-url и data-file-identifier...');
      $('button.btn-success[data-url][data-file-identifier]').each((i, elem) => {
        const $button = $(elem);
        const dataUrl = $button.attr('data-url')?.trim();
        const fileIdentifier = $button.attr('data-file-identifier')?.trim();
        
        if (dataUrl && fileIdentifier && !foundIds.has(fileIdentifier)) {
          foundIds.add(fileIdentifier);
          results.push({ 
            dataUrl, 
            fileIdentifier 
          });
          this.logger.debug(`Найдена кнопка btn-success: dataUrl="${dataUrl}", fileIdentifier="${fileIdentifier}"`);
        }
      });

      // Метод 4: Если все еще не нашли, ищем любые элементы с data-url и data-file-identifier
      if (results.length === 0) {
        this.logger.debug('Не найдено через стандартные методы, пробуем искать любые элементы с data-url и data-file-identifier...');
        $('[data-url][data-file-identifier]').each((i, elem) => {
          const $elem = $(elem);
          const dataUrl = $elem.attr('data-url')?.trim();
          const fileIdentifier = $elem.attr('data-file-identifier')?.trim();
          
          if (dataUrl && fileIdentifier && !foundIds.has(fileIdentifier)) {
            foundIds.add(fileIdentifier);
            results.push({ 
              dataUrl, 
              fileIdentifier 
            });
            this.logger.debug(`Найден элемент с data-url и data-file-identifier: dataUrl="${dataUrl}", fileIdentifier="${fileIdentifier}"`);
          }
        });
      }

      this.logger.debug(`Извлечено файлов через cheerio: ${results.length}`);
      
      // Диагностика: если ничего не найдено, выводим информацию о найденных элементах
      if (results.length === 0) {
        const allButtons = $('button').length;
        const buttonsWithDataUrl = $('button[data-url]').length;
        const buttonsWithFileId = $('button[data-file-identifier]').length;
        const addSignatureBlocks = $('.add_signature_block').length;
        
        this.logger.warn(`Не найдено файлов для подписи. Диагностика: всего кнопок=${allButtons}, с data-url=${buttonsWithDataUrl}, с data-file-identifier=${buttonsWithFileId}, блоков add_signature_block=${addSignatureBlocks}`);
        
        // Выводим первые несколько кнопок для отладки
        $('button[data-url]').slice(0, 3).each((i, elem) => {
          const $btn = $(elem);
          this.logger.debug(`Кнопка ${i + 1}: data-url="${$btn.attr('data-url')}", data-file-identifier="${$btn.attr('data-file-identifier')}", классы="${$btn.attr('class')}"`);
        });
      }
      
      return results;
    } catch (error) {
      this.logger.error(`Ошибка извлечения всех data-url и data-file-identifier: ${(error as Error).message}`);
      return results;
    }
  }

  /**
   * Извлечь все href из ссылок с текстом "Просмотреть" и "Дополнение к тех. спец."
   */
  extractAllViewHrefs(html: string): string[] {
    const hrefs: string[] = [];
    
    try {
      // Ищем все ссылки с текстом "Просмотреть" или "Дополнение к тех. спец."
      const linkPattern = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let linkMatch;
      
      while ((linkMatch = linkPattern.exec(html)) !== null) {
        const href = linkMatch[1];
        const linkContent = linkMatch[2];
        const cleanLinkText = this.cleanText(linkContent);
        
        if (cleanLinkText && (cleanLinkText.includes('Просмотреть') || cleanLinkText.includes('Дополнение к тех. спец.'))) {
          // Если href абсолютный, извлекаем путь
          let normalizedHref = href;
          if (href.startsWith('http')) {
            try {
              const url = new URL(href);
              normalizedHref = url.pathname + url.search;
            } catch (e) {
              normalizedHref = href;
            }
          }
          if (!hrefs.includes(normalizedHref)) {
            hrefs.push(normalizedHref);
          }
        }
      }

      return hrefs;
    } catch (error) {
      this.logger.error(`Ошибка извлечения всех href: ${(error as Error).message}`);
      return hrefs;
    }
  }

  /**
   * Извлечь номер лота (№ ПП) из таблицы на странице show_doc используя cheerio
   * Ищет первую строку таблицы и извлекает номер из второй колонки (№ ПП)
   * Также может извлечь ID из ссылки "Дополнение к тех. спец." если не найдено в таблице
   */
  extractLotNumber(html: string): string | null {
    try {
      const $ = cheerio.load(html);
      
      // Метод 1: Ищем в таблице
      const $tbody = $('tbody').first();
      if ($tbody.length > 0) {
        // Ищем первую строку <tr>
        const $firstRow = $tbody.find('tr').first();
        if ($firstRow.length > 0) {
          // Извлекаем все ячейки <td> из первой строки
          const $cells = $firstRow.find('td');
          
          if ($cells.length >= 2) {
            // Вторая колонка содержит № ПП (номер лота)
            // Пример: <td>81810134</td>
            const secondCellText = $cells.eq(1).text().trim();
            
            if (secondCellText && /^\d+$/.test(secondCellText)) {
              this.logger.debug(`Извлечен номер лота из таблицы (вторая колонка): ${secondCellText}`);
              return secondCellText;
            }

            // Если не удалось извлечь из второй колонки, пробуем из первой (может быть формат "81810134-КРБС1")
            const firstCellText = $cells.eq(0).text().trim();
            // Извлекаем только цифры из начала строки
            const numberMatch = firstCellText.match(/^(\d+)/);
            if (numberMatch && numberMatch[1]) {
              this.logger.debug(`Извлечен номер лота из таблицы (первая колонка): ${numberMatch[1]}`);
              return numberMatch[1];
            }
          }
        }
      }
      
      // Метод 2: Если не нашли в таблице, ищем ID из ссылки "Дополнение к тех. спец."
      // Ищем ссылку с текстом "Дополнение к тех. спец."
      let foundId: string | null = null;
      
      $('a').each((i, elem) => {
        if (foundId) return false; // Прерываем, если уже нашли
        
        const $link = $(elem);
        const href = $link.attr('href') || '';
        const linkText = $link.text().trim();
        const normalizedText = linkText.toLowerCase();
        
        // Проверяем, содержит ли текст ссылки "Дополнение к тех. спец."
        if (normalizedText.includes('дополнение') && 
            (normalizedText.includes('тех') || normalizedText.includes('тех.')) && 
            normalizedText.includes('спец')) {
          
          // Извлекаем ID из href: show_doc/{announceId}/{applicationId}/{docId}/{id}/{index}
          // Пример: show_doc/15834014/68100360/3357/79988804/2
          // Нужно извлечь 79988804 (id между docId и index)
          const idMatch = href.match(/\/show_doc\/[\d]+\/[\d]+\/[\d]+\/(\d+)\/[\d]+/i);
          
          if (idMatch && idMatch[1]) {
            foundId = idMatch[1].trim();
            this.logger.debug(`Извлечен ID из ссылки "Дополнение к тех. спец.": ${foundId}, href: "${href}"`);
            return false; // Прерываем цикл
          }
        }
      });
      
      if (foundId) {
        return foundId;
      }

      this.logger.warn('Не удалось извлечь номер лота ни из таблицы, ни из ссылки "Дополнение к тех. спец."');
      return null;
    } catch (error) {
      this.logger.error(`Ошибка извлечения номера лота: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Извлечь ID из ссылки "Дополнение к тех. спец." или любой ссылки с нужным index используя cheerio
   * @param html - HTML содержимое
   * @param announceId - ID объявления
   * @param docId - ID документа
   * @param index - Индекс (по умолчанию '1')
   * @returns ID (lotId) или null
   */
  extractIdFromDataSheetLink(html: string, announceId: string, docId: string, index: string = '1'): string | null {
    try {
      this.logger.debug(`Извлечение ID: announceId=${announceId}, docId=${docId}, index=${index}`);
      
      const $ = cheerio.load(html);
      
      // Метод 1: Ищем ссылку с текстом "Дополнение к тех. спец."
      let foundId: string | null = null;
      
      $('a').each((i, elem) => {
        if (foundId) return false; // Прерываем, если уже нашли
        
        const $link = $(elem);
        const href = $link.attr('href') || '';
        const linkText = $link.text().trim();
        const normalizedText = linkText.toLowerCase();
        
        // Проверяем, содержит ли текст ссылки "Дополнение к тех. спец."
        if (normalizedText.includes('дополнение') && 
            (normalizedText.includes('тех') || normalizedText.includes('тех.')) && 
            normalizedText.includes('спец')) {
          
          // Проверяем, содержит ли href нужный паттерн: show_doc/{announceId}/.../{docId}/{id}/{index}
          const idMatch = href.match(new RegExp(`show_doc/${announceId}/[\\d]+/${docId}/(\\d+)/${index}`, 'i'));
          
          if (idMatch && idMatch[1]) {
            foundId = idMatch[1].trim();
            this.logger.debug(`✅ ID найден из ссылки "Дополнение к тех. спец." через cheerio: ${foundId}, текст: "${linkText}"`);
            return false; // Прерываем цикл
          }
        }
      });
      
      if (foundId) {
        return foundId;
      }
      
      // Метод 2: Если не нашли "Дополнение", ищем любую ссылку с нужным паттерном, но не "Просмотреть"
      const foundLinks: Array<{ href: string; text: string; id: string }> = [];
      
      $('a').each((i, elem) => {
        const $link = $(elem);
        const href = $link.attr('href') || '';
        const linkText = $link.text().trim();
        const normalizedText = linkText.toLowerCase();
        
        // Пропускаем ссылки с текстом "Просмотреть"
        if (normalizedText.includes('просмотреть')) {
          return;
        }
        
        // Проверяем, содержит ли href нужный паттерн
        const idMatch = href.match(new RegExp(`show_doc/${announceId}/[\\d]+/${docId}/(\\d+)/${index}`, 'i'));
        
        if (idMatch && idMatch[1]) {
          const id = idMatch[1].trim();
          foundLinks.push({ href, text: linkText, id });
        }
      });
      
      if (foundLinks.length > 0) {
        const id = foundLinks[0].id;
        this.logger.debug(`✅ ID найден из ссылки (не "Просмотреть") через cheerio: ${id}, текст: "${foundLinks[0].text}"`);
        return id;
      }
      
      // Метод 3: Если все еще не нашли, берем первую ссылку с нужным паттерном
      $('a').each((i, elem) => {
        if (foundId) return false; // Прерываем, если уже нашли
        
        const $link = $(elem);
        const href = $link.attr('href') || '';
        
        const idMatch = href.match(new RegExp(`show_doc/${announceId}/[\\d]+/${docId}/(\\d+)/${index}`, 'i'));
        
        if (idMatch && idMatch[1]) {
          foundId = idMatch[1].trim();
          const linkText = $link.text().trim();
          this.logger.debug(`✅ ID найден из первой ссылки с нужным паттерном через cheerio: ${foundId}, текст: "${linkText}"`);
          return false; // Прерываем цикл
        }
      });
      
      if (foundId) {
        return foundId;
      }
      
      // Детальная диагностика
      this.logger.warn(`❌ Не удалось извлечь ID из ссылки для announceId=${announceId}, docId=${docId}, index=${index}`);
      
      // Ищем все ссылки с show_doc для диагностики
      const allShowDocLinks: Array<{ href: string; text: string }> = [];
      $('a[href*="show_doc"]').each((i, elem) => {
        const $link = $(elem);
        const href = $link.attr('href') || '';
        const linkText = $link.text().trim();
        allShowDocLinks.push({ href, text: linkText });
      });
      
      if (allShowDocLinks.length > 0) {
        this.logger.debug(`Всего ссылок с show_doc в HTML: ${allShowDocLinks.length}`);
        allShowDocLinks.slice(0, 10).forEach((link, idx) => {
          this.logger.debug(`  Ссылка ${idx + 1}: href="${link.href}", текст="${link.text}"`);
        });
      }
      
      // Ищем упоминания "Дополнение"
      const appendixLinks: Array<{ href: string; text: string }> = [];
      $('a').each((i, elem) => {
        const $link = $(elem);
        const linkText = $link.text().trim().toLowerCase();
        if (linkText.includes('дополнение')) {
          appendixLinks.push({ href: $link.attr('href') || '', text: $link.text().trim() });
        }
      });
      
      if (appendixLinks.length > 0) {
        this.logger.debug(`Найдено ссылок с "Дополнение": ${appendixLinks.length}`);
        appendixLinks.slice(0, 5).forEach((link, idx) => {
          this.logger.debug(`  Ссылка ${idx + 1}: href="${link.href}", текст="${link.text}"`);
        });
      }
      
      return null;
    } catch (error) {
      this.logger.error(`Ошибка извлечения ID из ссылки: ${(error as Error).message}`);
      return null;
    }
  }
}


