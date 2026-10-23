-- Safe audit for the Pognali demo-event seed.
-- The events themselves are stored in public.events and are tagged with [ДЕМО].
-- This query is read-only and can be rerun at any time; it never changes user or event data.
SELECT
  COUNT(*)::int AS demo_events,
  COUNT(DISTINCT title)::int AS unique_titles,
  COUNT(*) FILTER (WHERE latitude IS NULL OR longitude IS NULL)::int AS missing_coordinates,
  COUNT(*) FILTER (WHERE description NOT ILIKE '%демонстрац%' AND description NOT ILIKE '%демо-%')::int AS missing_demo_disclaimer,
  MIN(starts_at) AS earliest_start,
  MAX(starts_at) AS latest_start
FROM public.events
WHERE title LIKE '[ДЕМО]%'
  AND status = 'published';

-- Preview all demo events with their actual map coordinates and dates.
SELECT id, title, category, city, address, latitude, longitude, starts_at, capacity
FROM public.events
WHERE title LIKE '[ДЕМО]%' AND status = 'published'
ORDER BY starts_at, id;
