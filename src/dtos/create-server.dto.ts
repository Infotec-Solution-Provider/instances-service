import { Exclude, Type } from "class-transformer";
import { IsIP, IsInt, IsOptional, IsString, ValidateNested } from "class-validator";
import "reflect-metadata";

export class ServerDto {
    @IsIP()
    host: string;

    @IsInt()
    port: number;

    @IsString()
    username: string;

    @IsString()
    password: string;

    @IsString()
    database: string;

    @Exclude()
    @IsOptional()
    client_name?: string;
}

export class CreateServerDto {
    @ValidateNested()
    @Type(() => ServerDto)
    server: ServerDto;
}

