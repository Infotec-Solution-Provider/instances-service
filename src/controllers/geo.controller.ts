import { Request, Response, Router } from "express";
import { BadRequestError } from "@rgranatodutra/http-errors";
import GeoCacheService from "../services/geo-cache.service";

class GeoController {
	public readonly router: Router;

	constructor() {
		this.router = Router();

		this.router.get("/api/instances/geo/states", this.getStates);
		this.router.get("/api/instances/geo/states/:uf/cities", this.getCitiesByState);
	}

	private async getStates(_: Request, res: Response): Promise<Response> {
		const states = await GeoCacheService.getStates();

		return res.status(200).json({
			message: "Estados carregados com sucesso!",
			data: states,
		});
	}

	private async getCitiesByState(req: Request, res: Response): Promise<Response> {
		const uf = req.params["uf"]?.trim().toUpperCase();
		if (!uf || uf.length !== 2) {
			throw new BadRequestError("UF inválida.");
		}

		const cities = await GeoCacheService.getCitiesByState(uf);

		return res.status(200).json({
			message: "Cidades carregadas com sucesso!",
			data: cities,
		});
	}
}

export default GeoController;
