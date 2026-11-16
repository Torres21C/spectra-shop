import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { identityConfig } from './config/identity.config.js';

const port = Number.parseInt(process.env.PORT ?? '3001', 10);
const app = await NestFactory.create<NestExpressApplication>(AppModule);
app.getHttpAdapter().getInstance().disable('x-powered-by');
app.useBodyParser('json', { limit: '16kb' });
app.useBodyParser('urlencoded', { limit: '16kb', extended: false, parameterLimit: 30 });
app.use(cookieParser());
app.use(
  helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  }),
);
app.enableCors({
  origin: (origin, callback) => {
    if (!origin || identityConfig.allowedOrigins.has(origin)) callback(null, true);
    else callback(null, false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Request-Id'],
  exposedHeaders: ['X-Request-Id'],
  credentials: true,
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
  .setTitle('SPECTRA Shop — Identidad')
  .setDescription('Registro, autenticación y sesiones seguras de M02')
  .setVersion('1.0.0')
  .build();
SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, openApiConfig), {
  jsonDocumentUrl: 'docs-json',
});
app.enableShutdownHooks();
await app.listen(port, '0.0.0.0');
