import { Exclude } from "class-transformer";
import { IsObject, IsOptional } from "class-validator";
import "reflect-metadata";

export class CreateParametersDto {
    @IsObject()
    parameters: Record<string, any>;

    @Exclude()
    @IsOptional()
    client_name: string;
}
