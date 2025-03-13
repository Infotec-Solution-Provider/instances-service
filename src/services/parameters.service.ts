import { prisma } from "./prisma.service";

class ParametersService {
	public static async upsert(
		instanceName: string,
		parameters: Record<any, any>,
	): Promise<Record<string, any>> {
		const updatedParams = await prisma.parameters.upsert({
			create: {
				instanceName,
				parameters,
			},
			update: {
				parameters,
			},
			where: { instanceName },
		});

		return updatedParams.parameters as Record<string, any>;
	}
}

export default ParametersService;
