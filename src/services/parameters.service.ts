import { prisma } from "./prisma.service";

class ParametersService {
  public static async upsert(
    clientName: string,
    data: Record<any, any>
  ): Promise<Record<string, any>> {
    const { parameters } = await prisma.parameters.upsert({
      create: {
        client_name: clientName,
        parameters: data,
      },
      update: {
        parameters: data,
      },
      where: { client_name: clientName },
    });

    return parameters as Record<string, any>;
  }
}

export default ParametersService;
