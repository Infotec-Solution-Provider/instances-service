import { IsArray, IsOptional, IsString } from "class-validator";

export class QueryDto {
  @IsString()
  query: string;

  @IsOptional()
  @IsArray()
  parameters: unknown[];
}
