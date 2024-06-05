import { IsObject, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from "class-validator";
import { ServerDto } from "../../servers/dto/create-server.dto";
import { Type } from "class-transformer";
import "reflect-metadata";

export class CreateInstanceDto {
    @IsString()
    @MinLength(3)
    @MaxLength(16)
    name: string;

    @ValidateNested()
    @Type(() => ServerDto)
    @IsOptional()
    server?: ServerDto;

    @IsObject()
    @IsOptional()
    parameters?: Record<string, any>;
}