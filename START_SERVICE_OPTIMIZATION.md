# Оптимизация сервиса создания заявки (start)

## Текущий поток submitApplication

1. **authService.login()** — одна сессия.
2. **processAnnouncementCreate** (последовательно):
   - POST `ajax_create_application`
   - GET `ajax_create_application` (получение `applicationId`)
   - при наличии лотов: POST `ajax_add_lots`, POST `ajax_lots_next`
3. **Первый Promise.all** (5 операций параллельно):
   - `getIdDataSheetHandle(3357)` — даёт `taskId`, один GET `show_doc`
   - `appendixHandle(1356)` — GET + подпись + POST загрузка
   - `appendixHandle(3352)` — то же
   - `copyingQualificationInformation(3362)`
   - `obtainPermits(1351)`
4. **Второй Promise.all** (4 операции параллельно):
   - `setupBeneficialOwnershipInformation(3361, taskId)`
   - `addingBidSecurity(3353, taskId)`
   - `dataSheetHandle(3357, taskId, '1')`
   - `dataSheetHandle(3357, taskId, '2')`
5. **setPrice(3353)** — последовательно: EncryptOfferPrice (NCANode), setData (robotogo), возможен retry setData (2 попытки, 5 с задержка).

## Сделанные оптимизации

- **Убран дублирующий POST в appendix** (`appendix.service.ts`, `firstAppendixHandle`). Раньше один и тот же запрос загрузки выполнялся дважды; теперь один раз. Экономия: 2 лишних запроса на одну заявку (по одному на 1356 и 3352).

## Возможные дальнейшие улучшения

| Участок | Что можно сделать | Риск |
|--------|--------------------|------|
| **processAnnouncementCreate** | Если POST `ajax_create_application` в ответе уже возвращает `applicationId`, убрать отдельный GET | Нужно проверить ответ портала |
| **retryRequest** | Уменьшить начальную задержку с 1000 до 500 мс (и backoff 1.5x) | При нестабильном портале возможны лишние 429/503 |
| **setData** | Уменьшить задержку между попытками с 5 с до 2–3 с | При медленном robotogo возможны повторные ошибки |
| **dataSheetHandle / appendix** | Использовать кэш file-downloader (Redis: подпись/файл) для документов 1356/3352, чтобы не качать и не подписывать повторно | Требует согласования ключей Redis и сценариев |
| **EncryptOfferPrice** | Таймаут 30 с уже обёрнут в catch; при необходимости уменьшить таймаут (например до 15 с) | Редкие долгие ответы NCANode могут не успеть |
| **Логирование** | Сократить debug-логи в горячем пути (например, длинные HTML-превью) | Только влияние на I/O и размер логов |

## Рекомендации

1. Замерить время по этапам (processAnnouncementCreate, первый Promise.all, второй Promise.all, setPrice) и логировать длительность — так будет видно, где основная задержка.
2. После деплоя проверить стабильность заявок после удаления дублирующего POST в appendix.
3. При необходимости ускорения retry — снизить задержку в `retryRequest` и/или в retry `setData`, предварительно проверив поведение портала и robotogo под нагрузкой.
