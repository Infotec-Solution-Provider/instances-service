"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreateInstanceDto = void 0;
const class_validator_1 = require("class-validator");
const create_server_dto_1 = require("../../servers/dto/create-server.dto");
const class_transformer_1 = require("class-transformer");
require("reflect-metadata");
class CreateInstanceDto {
}
exports.CreateInstanceDto = CreateInstanceDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(3),
    (0, class_validator_1.MaxLength)(16),
    __metadata("design:type", String)
], CreateInstanceDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.ValidateNested)(),
    (0, class_transformer_1.Type)(() => create_server_dto_1.ServerDto),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", create_server_dto_1.ServerDto)
], CreateInstanceDto.prototype, "server", void 0);
__decorate([
    (0, class_validator_1.IsObject)(),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Object)
], CreateInstanceDto.prototype, "parameters", void 0);
//# sourceMappingURL=create-instance.dto.js.map