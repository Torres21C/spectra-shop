import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { trustProxySetting } from './common/trust-proxy.js';
import { InternalAppModule } from './internal-app.module.js';

const port = Number.parseInt(process.env.PORT ?? '3002', 10);
const internalPort = Number.parseInt(process.env.INTERNAL_PORT ?? '3102', 10);
const app = await NestFactory.create<NestExpressApplication>(AppModule);
// AWS-11: IP real del cliente detrás de CloudFront y del ALB (límites por IP, auditoría).
app.set('trust proxy', trustProxySetting());

app.getHttpAdapter().getInstance().disable('x-powered-by');
app.useBodyParser('json', { limit: '16kb' });
app.useBodyParser('urlencoded', { limit: '16kb', extended: false, parameterLimit: 50 });
// M06 mínimo: las rutas /admin leen la cookie de sesión y la de CSRF emitidas por Identity.
app.use(cookieParser());
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
  // M06 mínimo: POST /admin/products con cookies de sesión y token CSRF (solo orígenes permitidos).
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Request-Id', 'X-CSRF-Token'],
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
  .setTitle('SPECTRA Shop — Catálogo')
  .setDescription('API pública de M01 Catálogo y alta administrativa de productos (M06 mínimo)')
  .setVersion('1.0.0')
  .build();
SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, openApiConfig), {
  jsonDocumentUrl: 'docs-json',
});

app.enableShutdownHooks();

const internalApp = await NestFactory.create<NestExpressApplication>(InternalAppModule);
internalApp.getHttpAdapter().getInstance().disable('x-powered-by');
internalApp.useBodyParser('json', { limit: '16kb' });
internalApp.use(
  helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  }),
);
internalApp.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    stopAtFirstError: true,
  }),
);
internalApp.enableShutdownHooks();

await Promise.all([app.listen(port, '0.0.0.0'), internalApp.listen(internalPort, '0.0.0.0')]);
