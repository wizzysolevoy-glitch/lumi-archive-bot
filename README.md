# 🤖 Lumi Archive

Telegram-бот для сохранения веб-страниц в архив.

## Возможности

- 💾 Сохранение HTML-страниц по ссылке
- 📄 Авто-определение заголовка страницы
- 📜 История сохранённых архивов
- 👥 Реферальная система (+4 запроса за друга)
- 💰 Подписки: неделя/месяц/год
- 🔐 Админ-панель

## Технологии

- Node.js + Telegraf
- SQLite
- Koyeb (хостинг)

## Переменные окружения

```env
BOT_TOKEN=your_token
BOT_USERNAME=your_bot_username
ADMIN_ID=your_telegram_id
```

## Локальный запуск

```bash
npm install
node bot.js
```
