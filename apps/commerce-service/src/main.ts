import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { commerceConfig } from './config/commerce.config.js';

const port = Number.parseInt(process.env.PORT ?? '3003', 10);
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
    if (!origin || commerceConfig.allowedOrigins.has(origin)) callback(null, true);
    else callback(null, false);
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
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
  .setTitle('SPECTRA Shop — Carrito')
  .setDescription('API M03 para el carrito persistente del cliente')
  .setVersion('1.0.0')
  .addCookieAuth('spectra-access', { type: 'apiKey', in: 'cookie' }, 'access-cookie')
  .build();
SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, openApiConfig), {
  jsonDocumentUrl: 'docs-json',
});
app.enableShutdownHooks();
await app.listen(port, '0.0.0.0');
