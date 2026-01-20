import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '../http/http.service';
import { PortalService } from '../portal/portal.service';
import { NcanodeService } from '../ncanode/ncanode.service';
import { SessionService } from '../session/session.service';

import { globalSessionState } from './global-session-state';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private sessionToken: string | null = null;
  private isAuthenticated = false;

  constructor(
    private configService: ConfigService,
    private httpService: HttpService,
    private portalService: PortalService,
    private ncanodeService: NcanodeService,
    private sessionService: SessionService,
  ) {}

  async login(force: boolean = false): Promise<boolean> {
    try {
      // Флаг, указывающий, была ли выполнена новая авторизация
      let newAuthPerformed = false;
      
      // Проверяем, есть ли валидная сессия (быстрая локальная проверка без запроса к серверу)
      if (!force) {
        const session = this.sessionService.getSession();
        this.logger.log(`Проверка сессии: session=${!!session}, isAuthenticated=${session?.isAuthenticated}, cookies=${session?.cookies?.length || 0}`);
        
        const sessionValid = await this.sessionService.isValid();
        this.logger.log(`Результат проверки isValid(): ${sessionValid}`);
        
        if (sessionValid) {
          this.logger.log('Валидная сессия найдена, проверяем авторизацию (локальная проверка)...');
          // Используем skipServerCheck=true для быстрой проверки без запроса к серверу
          const isAuth = await this.checkAuth(true);
          if (isAuth) {
            this.logger.log('✅ Авторизация не требуется - сессия активна (локальная проверка)');
            this.isAuthenticated = true;
            // Обновляем глобальное состояние
            globalSessionState.isAuthenticated = true;
            globalSessionState.isValid = true;
            // НЕ вызываем authConfirm, так как используем существующую сессию
            return true;
          } else {
            this.logger.log('Сессия найдена, но локальная проверка не прошла, требуется повторная авторизация');
          }
        } else {
          this.logger.log(`Сессия невалидна или отсутствует. session=${!!session}, isAuthenticated=${session?.isAuthenticated}, cookies=${session?.cookies?.length || 0}`);
        }
      }
      
      // Если force=true или сессия невалидна, очищаем и создаем новую
      if (force || !await this.sessionService.isValid()) {
        this.logger.log('Очистка предыдущей сессии для новой авторизации...');
        await this.sessionService.clearSession();
        await this.httpService.clearCookies();
        this.isAuthenticated = false;
        this.sessionToken = null;
        // Обновляем глобальное состояние
        globalSessionState.isAuthenticated = false;
        globalSessionState.sessionToken = null;
        globalSessionState.isValid = false;
        globalSessionState.cookies = [];
        newAuthPerformed = true; // Устанавливаем флаг, что будет выполнена новая авторизация
      } else {
        // Если дошли сюда, значит сессия была валидна, но checkAuth вернул false
        // Это означает, что нужно выполнить новую авторизацию
        newAuthPerformed = true;
        this.logger.log('Сессия найдена, но проверка не прошла - выполняется новая авторизация');
      }
      
      this.logger.log('Начало авторизации...');

      // Шаг 1: Получаем ключ для подписи через PortalService
      this.logger.log('Получение ключа для подписи...');
      const key = await this.portalService.getAuthKey();
      console.log(`[AUTH] Ключ получен: ${key}`);

      // Шаг 2: Подписываем XML с ключом через ncanode
      this.logger.log('Подпись XML через ncanode...');
      const certPath = this.configService.get<string>('CERT_PATH', '');
      const certPassword = this.configService.get<string>('CERT_PASSWORD', '');

      const signedXmlResult = await this.ncanodeService.signWithNclayer(key, certPath, certPassword);
      this.logger.log('XML подписан');

      // Извлекаем подписанный XML
      let signedXml: string;
      if (typeof signedXmlResult === 'string') {
        signedXml = signedXmlResult;
      } else if (signedXmlResult && typeof signedXmlResult === 'object') {
        if (signedXmlResult.xml && typeof signedXmlResult.xml === 'string') {
          signedXml = signedXmlResult.xml;
        } else if (signedXmlResult.data && typeof signedXmlResult.data === 'string') {
          signedXml = signedXmlResult.data;
        } else {
          const found = Object.values(signedXmlResult).find(
            (v) => typeof v === 'string' && v.includes('<?xml') && v.includes('<ds:Signature'),
          );
          if (!found) {
            throw new Error('Не удалось извлечь подписанный XML из ответа ncanode');
          }
          signedXml = found as string;
        }
      } else {
        throw new Error('Неожиданный формат ответа от ncanode');
      }

      this.logger.log(`Подписанный XML извлечен, длина: ${signedXml.length}`);

      // Шаг 3: Отправляем подписанный XML через PortalService
      this.logger.log('Отправка подписанного XML на портал...');
      const authResponse = await this.portalService.sendSignedXml(signedXml);

      // Детальное логирование ответа авторизации
      this.logger.log(`=== Результат авторизации ===`);
      this.logger.log(`Success: ${authResponse.success}`);
      this.logger.log(`Status: ${authResponse.status}`);
      this.logger.log(`Cookies в ответе: ${authResponse.cookies?.length || 0}`);
      this.logger.log(`IsLoginPage: ${(authResponse as any).isLoginPage || false}`);
      this.logger.log(`=== Конец результата авторизации ===`);

      // Проверяем, не вернулась ли страница логина
      if ((authResponse as any).isLoginPage) {
        this.logger.error('❌ Авторизация не удалась: сервер вернул страницу логина');
        this.logger.error('Это означает, что подпись не была принята сервером');
        throw new Error('Авторизация не удалась: сервер вернул страницу логина. Проверьте подпись и сертификат.');
      }

      if (authResponse.success) {
        this.isAuthenticated = true;
        this.sessionToken = this.extractTokenFromResponse(authResponse);
        
        // Обновляем глобальное состояние
        globalSessionState.isAuthenticated = true;
        globalSessionState.sessionToken = this.sessionToken;
        globalSessionState.lastAuthTime = Date.now();
        globalSessionState.isValid = true;
        
        // Сохраняем статус авторизации в сессию
        await this.sessionService.updateAuthStatus(true);
        if (this.sessionToken) {
          await this.sessionService.updateToken(this.sessionToken);
        }
        
        // Сохраняем cookies в сессию
        await this.sessionService.saveCookies();
        
        // Обновляем cookies в глобальном состоянии
        const cookies = await this.httpService.getCookiesAsArray();
        globalSessionState.cookies = cookies;
        
        // Логируем количество cookies для диагностики
        this.logger.log(`✅ Авторизация успешна. Сохранено cookies: ${cookies.length}`);
        if (cookies.length > 0) {
          const sessionCookies = cookies.filter(c => 
            c.toLowerCase().includes('session') || 
            c.toLowerCase().includes('sid') ||
            c.toLowerCase().includes('jsessionid')
          );
          this.logger.log(`Сессионные cookies: ${sessionCookies.length}`);
        }
        
        // Шаг 3.5: Если был редирект на auth_confirm, получаем эту страницу для обновления сессии
        // if (authResponse.status === 302 || authResponse.status === 301) {
        //   const location = authResponse.headers?.location || '';
        //   if (location.includes('auth_confirm')) {
        //     this.logger.log('Получение страницы auth_confirm после редиректа...');
        //     try {
        //       await this.portalService.getHomePage(); // Просто обновляем сессию
        //       this.logger.log('Сессия обновлена после редиректа');
        //     } catch (error) {
        //       this.logger.warn(`Ошибка обновления сессии: ${(error as Error).message}`);
        //     }
        //   }
        // }
        
        // Шаг 4: Подтверждение авторизации (auth_confirm) - ТОЛЬКО при новой авторизации
        // Если использовалась существующая сессия, auth_confirm не требуется
        if (newAuthPerformed) {
          this.logger.log('Подтверждение авторизации (auth_confirm) - новая авторизация...');
          const password = this.configService.get<string>('AUTH_PASSWORD', '');
          if (password) {
              try {
                const confirmResponse = await this.portalService.authConfirm(password);
                if (confirmResponse.success && !confirmResponse.redirectedToAuth) {
                  this.logger.log('Подтверждение авторизации успешно');
                  
                  // Шаг 5: Получение страницы заявки и извлечение номера заявки
                  const applicationId = this.configService.get<string>('APPLICATION_ID', '67519020');
                  if (applicationId) {
                  try {
                    this.logger.log(`Получение страницы заявки ${applicationId}...`);
                    const applicationPage = await this.portalService.getApplicationPage(applicationId);
                    if (applicationPage.redirectedToAuth) {
                      this.logger.error('❌ Страница заявки перенаправила на авторизацию. Возможно, сессия истекла или cookies не сохранились.');
                    } else if (applicationPage.success && applicationPage.html) {
                      const applicationNumber = this.portalService.extractApplicationNumber(applicationPage.html);
                      if (applicationNumber) {
                        this.logger.log(`✅ Номер заявки: ${applicationNumber}`);
                        console.log(`[AUTH] Номер заявки: ${applicationNumber}`);
                        
                        // Открываем страницу заявки в Google Chrome
                      } else {
                        this.logger.warn('Не удалось извлечь номер заявки из HTML');
                      }
                    } else {
                      this.logger.warn(`Не удалось получить страницу заявки. Статус: ${applicationPage.status}`);
                    }
                  } catch (error) {
                    this.logger.error(`Ошибка получения страницы заявки: ${error.message}`);
                    // Не прерываем процесс
                  }
                  }
                } else {
                  if (confirmResponse.redirectedToAuth) {
                    this.logger.error('❌ Подтверждение авторизации не удалось: перенаправление на страницу авторизации. Возможно, сессия истекла или cookies не сохранились.');
                  } else {
                    this.logger.warn(`Подтверждение авторизации не удалось. Статус: ${confirmResponse.status}`);
                  }
                }
            } catch (error) {
              this.logger.error(`Ошибка подтверждения авторизации: ${error.message}`);
              // Не прерываем процесс, так как основная авторизация уже выполнена
            }
          } else {
            this.logger.warn('Пароль не указан в конфигурации (AUTH_PASSWORD), пропускаем подтверждение');
          }
        } else {
          this.logger.log('Пропускаем auth_confirm - используется существующая сессия');
        }
        
        this.logger.log(`Авторизация успешна`);
        console.log(`[AUTH] Авторизация выполнена`);
        
        return true;
      }

      throw new Error(`Авторизация не удалась. Статус: ${authResponse.status}`);
    } catch (error) {
      this.logger.error(`Ошибка авторизации: ${error.message}`);
      if ((error as any).response) {
        this.logger.error(
          `Ответ сервера: ${(error as any).response.status} ${JSON.stringify((error as any).response.data)}`,
        );
      }
      this.isAuthenticated = false;
      // Обновляем глобальное состояние
      globalSessionState.isAuthenticated = false;
      globalSessionState.isValid = false;
      throw error;
    }
  }


  private extractTokenFromResponse(response: any): string | null {
    try {
      if (response.data && typeof response.data === 'object') {
        return response.data.token || response.data.sessionToken || response.data.accessToken;
      }

      const cookies = response.headers['set-cookie'];
      if (cookies) {
        for (const cookie of cookies) {
          const tokenMatch = cookie.match(/(?:token|session|auth)=([^;]+)/i);
          if (tokenMatch) {
            return tokenMatch[1];
          }
        }
      }

      return null;
    } catch (error) {
      this.logger.error(`Ошибка извлечения токена: ${error.message}`);
      return null;
    }
  }




  async checkAuth(skipServerCheck: boolean = false): Promise<boolean> {
    try {
      // Быстрая локальная проверка: проверяем валидность сессии без запроса к серверу
      const session = this.sessionService.getSession();
      if (!session || !session.cookies || session.cookies.length === 0) {
        this.logger.debug('Нет cookies в сессии, требуется авторизация');
        this.isAuthenticated = false;
        // Обновляем глобальное состояние
        globalSessionState.isAuthenticated = false;
        globalSessionState.isValid = false;
        return false;
      }
      
      // Проверяем валидность сессии локально (по времени и наличию данных)
      const isValid = await this.sessionService.isValid();
      if (!isValid) {
        this.logger.debug('Сессия невалидна (локальная проверка), требуется авторизация');
        this.isAuthenticated = false;
        // Обновляем глобальное состояние
        globalSessionState.isAuthenticated = false;
        globalSessionState.isValid = false;
        return false;
      }
      
      // Если skipServerCheck=true, возвращаем результат локальной проверки без запроса к серверу
      if (skipServerCheck) {
        this.logger.debug('Проверка сессии пропущена (локальная проверка пройдена)');
        this.isAuthenticated = session.isAuthenticated || true; // Если сессия валидна локально, считаем авторизованным
        // Обновляем глобальное состояние
        globalSessionState.isAuthenticated = this.isAuthenticated;
        globalSessionState.isValid = true;
        globalSessionState.cookies = session.cookies || [];
        return this.isAuthenticated;
      }
      
      // Опциональная проверка на сервере (только если skipServerCheck=false)
      // Это можно использовать для периодической проверки, но не при каждом вызове
      this.logger.debug('Выполняется проверка авторизации на сервере...');
      const response = await this.portalService.getHomePage();
      
      // Если получили редирект на страницу авторизации, значит сессия невалидна
      if (response.redirectedToAuth) {
        this.logger.debug('Редирект на страницу авторизации - сессия невалидна на сервере');
        this.isAuthenticated = false;
        // Обновляем глобальное состояние
        globalSessionState.isAuthenticated = false;
        globalSessionState.isValid = false;
        await this.sessionService.updateAuthStatus(false);
        return false;
      }
      
      this.isAuthenticated = response.success;
      if (this.isAuthenticated) {
        await this.sessionService.updateAuthStatus(true);
        // Обновляем глобальное состояние
        globalSessionState.isAuthenticated = true;
        globalSessionState.isValid = true;
        const cookies = await this.httpService.getCookiesAsArray();
        globalSessionState.cookies = cookies;
      } else {
        globalSessionState.isAuthenticated = false;
        globalSessionState.isValid = false;
      }
      return this.isAuthenticated;
    } catch (error) {
      this.logger.debug(`Ошибка проверки авторизации: ${(error as Error).message}`);
      // При ошибке считаем, что локальная проверка прошла (если сессия валидна)
      const session = this.sessionService.getSession();
      if (session && await this.sessionService.isValid()) {
        this.logger.debug('Ошибка проверки на сервере, но локальная сессия валидна - используем её');
        this.isAuthenticated = true;
        // Обновляем глобальное состояние
        globalSessionState.isAuthenticated = true;
        globalSessionState.isValid = true;
        globalSessionState.cookies = session.cookies || [];
        return true;
      }
      this.isAuthenticated = false;
      await this.sessionService.updateAuthStatus(false);
      return false;
    }
  }

  async logout(): Promise<void> {
    try {
      await this.portalService.logout();
      this.isAuthenticated = false;
      this.sessionToken = null;
      await this.sessionService.clearSession();
      this.logger.log('Выход выполнен, сессия очищена');
    } catch (error) {
      this.logger.error(`Ошибка выхода: ${error.message}`);
    }
  }

  getSessionToken(): string | null {
    return this.sessionToken;
  }

  getIsAuthenticated(): boolean {
    return this.isAuthenticated;
  }

}
