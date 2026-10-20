import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class WalletTransferDto {
    @IsNotEmpty()
    @IsString()
    toAddress!: string;

    @IsNotEmpty()
    amount!: string | number;

    @IsOptional()
    @IsString()
    network?: string;

    @IsOptional()
    @IsString()
    confirmation?: string;
}

export class WalletSignTestnetDto {
    @IsNotEmpty()
    transaction!: unknown;
}

export class WalletExportDto {
    @IsOptional()
    @IsString()
    network?: string;

    @IsOptional()
    @IsString()
    confirmation?: string;
}
