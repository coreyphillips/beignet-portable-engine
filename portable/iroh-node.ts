/** Native hosts supply the endpoint factory; the Node binding is never bundled. */
export async function createNodeIrohEndpoint(): Promise<never> {
	throw new Error('This host must provide an Iroh endpoint factory.');
}
