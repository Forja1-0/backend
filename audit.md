# Auditoría de Cambios - Motor del Bot y NLP

Se ha realizado una refactorización y ampliación masiva de la lógica del bot de WhatsApp para convertirlo en un motor conversacional mucho más inteligente, robusto y estructurado. A continuación se detalla todo lo que se ha implementado:

## 1. Nuevo Sistema de Parsing y Procesamiento de Lenguaje (NLP) (`src/bot/parser/`)
Se construyó un motor de entendimiento de texto propio antes de recurrir a la IA:
- **`intent-classifier.ts`**: Un clasificador de intenciones que analiza el texto del usuario y determina qué quiere hacer (registrar comida, entrenar, consultar, saludar, reportar lesión, etc.).
- **`meal-parser.ts`**: Un sistema híbrido para procesar comidas. Si el usuario usa un alias o una forma rápida, lo detecta por código. Si es descriptivo, usa Gemini pero validando contra la base de datos (SARA) local. Además, asigna un nivel de **confianza (confidence)** para decidir si auto-guarda la comida o si le pide confirmación al usuario.
- **`normalize.ts` & `patterns.ts`**: Funciones para limpiar el texto (quitar acentos, puntuación) y extraer datos crudos (ej: números sueltos o gramos).
- **`fuzzy.ts`**: Implementa el algoritmo de Levenshtein para tolerar errores ortográficos leves ("typos") en los comandos.

## 2. Refactorización del Enrutador (`src/bot/router.ts`)
El router ahora confía en el nuevo `intent-classifier` en lugar de tener `if/else` básicos. Extrae la intención, la limpieza del texto y deriva el mensaje al manejador (handler) correspondiente. También mantiene la prioridad para flujos conversacionales en curso (sesiones activas).

## 3. Nuevos Manejadores (Handlers) (`src/bot/handlers/`)
Se añadieron flujos específicos para distintas intenciones:
- **`command.handler.ts`**: Manejo de comandos explícitos de la plataforma (ver perfil, pedir ayuda y flujo de confirmación de baja de servicio).
- **`disruption.handler.ts`**: Capta contingencias (lesiones, enfermedades o deslices de comida) y las guarda en la tabla de `events` para tener un registro histórico.
- **`greeting.handler.ts`**: Respuestas dinámicas y amigables ante saludos o agradecimientos.
- **`query.handler.ts`**: Permite al usuario preguntar "¿cómo vengo hoy?" o "¿cómo vengo en la semana?", leyendo los datos de las vistas SQL y resumiendo macros restantes o puntajes (scores) semanales.

## 4. Evolución de Handlers Existentes
- **`meal.handler.ts`**: Ahora evalúa el nivel de confianza de lo que entendió. Si es claro (>= 0.7), lo guarda y avisa. Si no, le pregunta al usuario "Entendí esto, ¿lo guardo?".
- **`checkin.handler.ts`**: Ahora usa **Gemini** al final del flujo de check-in nocturno (`generateNightlySummary`) para darle un feedback motivacional diario personalizado basado en su nutrición, sueño y nivel de dolor.
- **`training.handler.ts`**: Detecta de forma más inteligente el nombre de la sesión basándose en la gramática y registra apropiadamente el esfuerzo (RPE).

## 5. Personalidad Centralizada (`src/bot/personality/templates.ts`)
Se separó todo el texto ("copys") de los handlers. Ahora existe un archivo de plantillas donde se definen las respuestas del bot. Esto asegura consistencia, facilita el cambio de tono y hace el código de los handlers mucho más limpio.

## 6. Base de Datos y Repositorios (`src/repositories/`)
- Se implementó **`frequent-meal.repo.ts`** para llevar registro de comidas frecuentes e incrementar su contador de uso.
- Adaptaciones en `food.repo.ts` (SARA) para mejorar las búsquedas por similitud.
- Mejoras en `daily.repo.ts` y `training.repo.ts` integrando el manejo completo de `upsert` y reportes (queries semanales).

## 7. Inteligencia Artificial (`src/services/gemini.service.ts`)
Se migró Gemini para usar **Structured Outputs (JSON Schema)** en el parseo de comidas. Ahora la IA devuelve siempre un objeto predecible con macros y gramos, evitando respuestas en texto libre que antes rompían el bot. También se añadió el prompt para el resumen nocturno de rendimiento.

---
**En resumen**: El bot pasó de ser un respondedor estático a un asistente inteligente (con su propio motor de reglas + IA), que pre-procesa intenciones, tolera errores, guarda sesiones y se comunica mediante una personalidad definida.
