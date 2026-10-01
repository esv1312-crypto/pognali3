# Pognali ChatGPT MVP — Data Contract

## User

```json
{
  "id": "user_123",
  "name": "Имя",
  "age": 31,
  "city": "Екатеринбург",
  "country": "RU"
}
```

Возраст пользователя нужен для проверки возрастного диапазона события.

## Event

```json
{
  "id": "event_123",
  "title": "Футбол",
  "emoji": "⚽",
  "category": "sport",
  "date": "2026-10-01",
  "time": "20:30",
  "place": {
    "name": "Парк",
    "city": "Екатеринбург",
    "lat": 56.84,
    "lng": 60.60
  },
  "description": "Дружеская игра",
  "max_participants": 10,
  "min_age": 18,
  "max_age": 35,
  "creator_id": "user_123",
  "participant_count": 7
}
```

## Participant

```json
{
  "event_id": "event_123",
  "user_id": "user_456",
  "joined_at": "2026-10-01T12:00:00Z"
}
```

## Core operations

### search_events

Вход:
- city / location hint
- date
- optional radius
- optional category
- optional user age

Правило MVP: без запроса на другой город по умолчанию искать события **на сегодня и рядом**.

Выход:
- компактный список событий
- participant_count
- max_participants
- age range
- distance / locality when available

### get_event

Возвращает полную карточку события и актуальное количество участников.

### join_event

Перед присоединением проверить:
1. событие существует;
2. событие ещё актуально;
3. есть свободное место;
4. пользователь ещё не участник;
5. возраст пользователя входит в диапазон события.

После успешного присоединения вернуть актуальный participant_count.

### create_event

Обязательные поля:
- title
- date
- time
- place
- max_participants
- min_age
- max_age

Дополнительно:
- category
- emoji
- description

### send_message

Отправляет сообщение в чат события.

## Location

Местоположение от ChatGPT рассматривается как подсказка для поиска, а не как механизм авторизации.

Если location hint отсутствует, пользователь может назвать город сам.


### Invitations

`create_invite` создаёт адресное приглашение существующему пользователю события. Приглашение не увеличивает `participant_count`: место занимает только фактический `join_event`. Повторная отправка активного приглашения запрещена.

`get_user_invites` возвращает приглашения конкретного пользователя.
