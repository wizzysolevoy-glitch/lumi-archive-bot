# 🚀 Lumi Archive — Деплой на VPS

## Что нового в этой версии

✅ **Исправлены все ошибки**
- Смешанные кавычки в строках
- Неработающий `ctx.session` заменён на `Map()`
- Исправлена реферальная система (rewarded выставляется)

✅ **Новые фичи**
- 💾 **Реальная архивация** — бот скачивает HTML страницы
- 📄 **Авто-определение заголовка** (title)
- 💾 **Сохранение файлов** в папку `archives/`
- 🔐 **Админ-панель** (`/admin`)
- 📊 **Статистика** бота
- 🎁 **Выдача запросов** пользователям
- 👥 **Улучшенная рефералка**

---

## 📋 Требования

- Ubuntu 20.04+ / Debian 11+
- Node.js 18+
- 512 MB RAM минимум
- 2 GB SSD

---

## 🔧 Установка на VPS

### 1. Подключаемся к серверу

```bash
ssh root@ТВОЙ_IP
```

### 2. Обновляем систему

```bash
apt update && apt upgrade -y
```

### 3. Устанавливаем Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs git
```

### 4. Клонируем проект

```bash
cd /opt
git clone https://github.com/wizzysolevoy-glitch/sea.git lumi-archive
cd lumi-archive
```

### 5. Устанавливаем зависимости

```bash
npm install
```

### 6. Создаём .env

```bash
nano .env
```

Вставь:
```
BOT_TOKEN=8737480480:AAECwGziC-IWYtgiFqeJgf26V--E3DkaFZU
BOT_USERNAME=lumi_archive
ADMIN_ID=ТВОЙ_TELEGRAM_ID
```

**Как узнать свой Telegram ID:**
- Напиши @userinfobot
- Он пришлёт твой ID

Сохрани: `Ctrl+O`, `Enter`, `Ctrl+X`

### 7. Тестовый запуск

```bash
node bot.js
```

Если видишь:
```
🚀 Lumi Archive Bot запущен!
🤖 @lumi_archive
🔐 Админ ID: 123456789
```

— всё работает! Останови: `Ctrl+C`

### 8. Устанавливаем PM2 (чтобы бот работал 24/7)

```bash
npm install -g pm2
pm2 start bot.js --name "lumi-archive"
pm2 save
pm2 startup
```

Выполни команду, которую выдаст `pm2 startup` (она создаст автозапуск).

### 9. Проверяем

```bash
pm2 status
pm2 logs lumi-archive
```

---

## 🔐 Админ-панель

Отправь боту команду: `/admin`

Доступные функции:
- 📊 **Статистика** — пользователи, запросы, архивы
- 👥 **Список пользователей** — все кто использовал бота
- 🎁 **Выдать запросы** — пополнить баланс любому юзеру

---

## 📁 Структура

```
lumi-archive/
├── bot.js              # Главный файл
├── package.json        # Зависимости
├── .env                # Переменные окружения
├── lumi_archive.db     # База данных SQLite
├── archives/           # Сохранённые HTML файлы
└── README_VPS.md       # Этот файл
```

---

## 🔄 Обновление бота

Когда выкладываешь новый код:

```bash
cd /opt/lumi-archive
git pull
pm2 restart lumi-archive
```

---

## 🆘 Если что-то не так

```bash
# Проверить логи
pm2 logs lumi-archive

# Перезапустить
pm2 restart lumi-archive

# Остановить
pm2 stop lumi-archive
```

---

## 💡 Советы

1. **База данных** (`lumi_archive.db`) — хранит всё локально. Сделай бэкап:
   ```bash
   cp lumi_archive.db lumi_archive.db.backup
   ```

2. **Архивы** хранятся в папке `archives/`. При необходимости чисти старые.

3. **Если VPS перезагрузится** — PM2 автоматически запустит бота.

---

## 📞 Поддержка

Если есть вопросы — пиши! 🚀
