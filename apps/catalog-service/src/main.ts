import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module.js';

const port = Number.parseInt(process.env.PORT ?? '3002', 10);
const app = await NestFactory.create<NestExpressApplication>(AppModule);

app.getHttpAdapter().getInstance().disable('x-powered-by');
app.useBodyParser('json', { limit: '16kb' });
app.useBodyParser('urlencoded', { limit: '16kb', extended: false, parameterLimit: 50 });
app.use(
  helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  }),
);

const allowedOrigins = new Set(
  (process.env.CORS_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);
app.enableCors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.has(origin)) callback(null, true);
    else callback(null, false);
  },
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Request-Id'],
  exposedHeaders: ['X-Request-Id'],
  credentials: false,
  maxAge: 600,
});

app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    stopAtFirstError: true,
  }),
);

const openApiConfig = new DocumentBuilder()
  .setTitle('SPECTRA Shop — Catálogo')
  .setDescription('API pública de solo lectura para M01 Catálogo')
  .setVersion('1.0.0')
  .build();
SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, openApiConfig), {
  jsonDocumentUrl: 'docs-json',
});

app.enableShutdownHooks();
await app.listen(port, '0.0.0.0');
