# Pognali MCP tools

## search_events

Назначение: найти события на сегодня рядом с пользователем.

Вход:
- city/location hint
- date
- optional category
- optional age

Выход:
- id
- title
- emoji
- time
- place
- participant_count
- max_participants
- age range

## get_event

Вход: event_id.

Выход: полная актуальная карточка события.

## join_event

Вход:
- event_id
- user_id
- user_age

Успех: участник добавлен и возвращён актуальный participant_count.

Ошибки:
- EVENT_NOT_FOUND
- EVENT_FULL
- ALREADY_JOINED
- AGE_RESTRICTED
- EVENT_EXPIRED

## create_event

Вход:
- title
- category / emoji
- date
- time
- place
- max_participants
- min_age
- max_age
- description

## send_message

Вход:
- event_id
- user_id
- text
