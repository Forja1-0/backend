-- Fix puntual: merge del usuario fantasma que creó WhatsApp por desajuste
-- de formato de teléfono (onboarding guardó "2645267544", WA mandó
-- "5492645267544"). Re-ejecutable: si ya está limpio, no hace nada.
--
-- Perfil real (onboarding completo) : a271479e-1a1b-481f-b25d-341fd434d7e5
-- Shell creado por WhatsApp          : 2c7288c1-53de-40cc-b225-961e427f1a4e

BEGIN;

-- 1. Soltar el wa_chat_id que retiene el shell (wa_chat_id es UNIQUE; sin
--    esto el UPDATE de abajo violaría la constraint).
UPDATE users
SET wa_chat_id = NULL, updated_at = now()
WHERE id = '2c7288c1-53de-40cc-b225-961e427f1a4e';

-- 2. Vincular el chat de WhatsApp al perfil real + normalizar su teléfono
--    al formato canónico (549 + nacional) para que coincida a futuro.
UPDATE users
SET wa_chat_id = '5492645267544@s.whatsapp.net',
    phone_wa   = '5492645267544',
    updated_at = now()
WHERE id = 'a271479e-1a1b-481f-b25d-341fd434d7e5';

-- 3. Borrar el shell (onboarding_step 0, sin datos). Los hijos caen por
--    ON DELETE CASCADE.
DELETE FROM users
WHERE id = '2c7288c1-53de-40cc-b225-961e427f1a4e';

COMMIT;

-- Verificación:
-- SELECT id, name, phone_wa, wa_chat_id, onboarding_step
-- FROM users WHERE phone_wa LIKE '%2645267544%';
