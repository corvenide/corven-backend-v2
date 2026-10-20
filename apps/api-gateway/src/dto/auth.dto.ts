import { IsEmail, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';

export class RegisterDto {
    @IsNotEmpty()
    @IsString()
    name!: string;

    @IsNotEmpty()
    @IsEmail()
    email!: string;

    @IsNotEmpty()
    @IsString()
    @MinLength(6)
    password!: string;
}

export class LoginDto {
    @IsNotEmpty()
    @IsEmail()
    email!: string;

    @IsNotEmpty()
    @IsString()
    password!: string;
}

export class WalletChallengeDto {
    @IsNotEmpty()
    @IsString()
    walletAddress!: string;
}

export class WalletLoginDto {
    @IsNotEmpty()
    @IsString()
    walletAddress!: string;

    @IsNotEmpty()
    @IsString()
    challengeId!: string;

    @IsNotEmpty()
    signature!: unknown;
}

export class GoogleLoginDto {
    @IsNotEmpty()
    @IsString()
    credential!: string;
}
