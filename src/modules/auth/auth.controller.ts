import { Controller, Post, Get, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  async login() {
    try {
      const result = await this.authService.login();
      return {
        success: result,
        message: result ? 'Авторизация успешна' : 'Авторизация не удалась',
        token: this.authService.getSessionToken(),
      };
    } catch (error) {
      return {
        success: false,
        message: error.message,
      };
    }
  }

  @Get('status')
  async getStatus() {
    return {
      isAuthenticated: this.authService.getIsAuthenticated(),
      hasToken: !!this.authService.getSessionToken(),
    };
  }

  @Post('check')
  async check() {
    const isAuth = await this.authService.checkAuth();
    return {
      isAuthenticated: isAuth,
    };
  }

  @Post('logout')
  async logout() {
    await this.authService.logout();
    return {
      success: true,
      message: 'Выход выполнен',
    };
  }
}



















