import apigateway = require('@aws-cdk/aws-apigateway');
import cdk = require('@aws-cdk/cdk');

import { isRuntime } from '../constants';
import { RuntimeContext } from '../runtime';
import { jsonSchema, Kind, Mapper, Raw, Shape, StructType, Type } from '../shape';
import { Tree } from '../tree';
import { Method, MethodName, RequestMappings, Response, Responses } from './method';
import { StatusCode } from './request-response';
import { $context, isMapping, Mapping, TypedMapping } from './variable';

type ResponseMappers = {
  [status in StatusCode]: Mapper<any, string>;
};
interface Handler<T> {
  requestMapper: Mapper<T, string>;
  handler: (request: T, context: any) => Promise<Response<any, any>>;
  responseMappers: ResponseMappers;
}
type MethodHandlers = { [method: string]: Handler<any>; };

export class Resource extends Tree<Resource> {
  public readonly resource: apigateway.Resource;

  protected readonly restApiId: string;
  protected readonly getRequestValidator: apigateway.CfnRequestValidator;
  protected readonly bodyRequestValidator: apigateway.CfnRequestValidator;

  private readonly methods: MethodHandlers;

  constructor(parent: Resource, pathPart: string, options: apigateway.ResourceOptions) {
    super(parent, pathPart);
    this.methods = {};

    if (parent) {
      this.restApiId = parent.restApiId;
      this.resource = parent.resource.addResource(pathPart, options);
      this.getRequestValidator = parent.getRequestValidator;
      this.bodyRequestValidator = parent.bodyRequestValidator;
    }
  }

  public async handle(event: any, context: any): Promise<any> {
    console.log('resource handle', event);
    const upperHttpMethod = event.__httpMethod.toUpperCase();
    const handler = this.methods[upperHttpMethod];
    if (handler) {
      const request = handler.requestMapper.read(event);
      let result: Response<any, any>;
      let responseMapper: Mapper<any, any>;
      try {
        result = await handler.handler(request, context);
        responseMapper = (handler.responseMappers as any)[result.statusCode];
      } catch (err) {
        console.error('api gateway handler threw error', err.message);
        throw err;
      }
      if (responseMapper === undefined) {
        throw new Error(`unexpected status code: ${result.statusCode}`);
      }
      try {
        const payload = responseMapper.write(result.payload);
        if (result.statusCode === StatusCode.Ok) {
          return payload;
        } else {
          throw new Error(JSON.stringify({
            statusCode: result.statusCode,
            body: payload
          }));
        }
      } catch (err) {
        console.error('failed to serialize payload', err);
        throw err;
      }
    } else {
      throw new Error(`No handler for http method: ${event.httpMethod}`);
    }
  }

  public setDeleteMethod<R extends RuntimeContext, T extends Shape, U extends Responses>(method: Method<R, T, U, 'DELETE'>) {
    this.addMethod('DELETE', method);
  }

  public setGetMethod<R extends RuntimeContext, T extends Shape, U extends Responses>(method: Method<R, T, U, 'GET'>) {
    this.addMethod('GET', method);
  }

  public setHeadMethod<R extends RuntimeContext, T extends Shape, U extends Responses>(method: Method<R, T, U, 'HEAD'>) {
    this.addMethod('HEAD', method);
  }

  public setOptionsMethod<R extends RuntimeContext, T extends Shape, U extends Responses>(method: Method<R, T, U, 'OPTIONS'>) {
    this.addMethod('OPTIONS', method);
  }

  public setPatchMethod<R extends RuntimeContext, T extends Shape, U extends Responses>(method: Method<R, T, U, 'PATCH'>) {
    this.addMethod('PATCH', method);
  }

  public setPostMethod<R extends RuntimeContext, T extends Shape, U extends Responses>(method: Method<R, T, U, 'POST'>) {
    this.addMethod('POST', method);
  }

  public setPutMethod<R extends RuntimeContext, T extends Shape, U extends Responses>(method: Method<R, T, U, 'PUT'>) {
    this.addMethod('PUT', method);
  }

  public addResource(pathPart: string, options: apigateway.ResourceOptions = {}): Resource {
    return new Resource(this, pathPart, options);
  }

  private addMethod<R extends RuntimeContext, T extends Shape, U extends Responses, M extends MethodName>(methodName: M, method: Method<R, T, U, M>) {
    this.makeHandler(methodName, method);
    if (isRuntime()) {
      // don't do expensive work at runtime
      return;
    }

    const methodResource = this.resource.addMethod(methodName, method.integration);
    const cfnMethod = methodResource.node.findChild('Resource') as apigateway.CfnMethod;

    const requestShape = method.request.shape;
    (cfnMethod.propertyOverrides as any).integration = {
      passthroughBehavior: 'NEVER',
      requestTemplates: {
        'application/json': velocityTemplate(requestShape, {
          ...method.request.mappings as object,
          __resourceId: $context.resourceId,
          __httpMethod: $context.httpMethod
        })
      },
      integrationResponses: Object.keys(method.responses).map(statusCode => {
        if (statusCode.toString() === StatusCode.Ok.toString()) {
          return {
            statusCode,
            selectionPattern: ''
          };
        } else {
          return {
            statusCode,
            selectionPattern: `\\{"statusCode":${statusCode}.*`,
            responseTemplates: {
              'application/json': velocityTemplate(
                (method.responses as any)[statusCode] as any, {},
                "$util.parseJson($input.path('$.errorMessage')).body")
            }
          };
        }
      })
    };

    if (methodName === 'GET') {
      (cfnMethod.propertyOverrides as any).requestValidatorId = this.getRequestValidator.requestValidatorId;
    } else {
      (cfnMethod.propertyOverrides as any).requestValidatorId = this.bodyRequestValidator.requestValidatorId;
    }
    (cfnMethod.propertyOverrides as any).requestModels = {
      'application/json': new apigateway.CfnModel(methodResource, 'Request', {
        restApiId: this.restApiId,
        contentType: 'application/json',
        schema: jsonSchema(requestShape)
      }).modelName
    };
    const responses = new cdk.Construct(methodResource, 'Response');
    (cfnMethod.propertyOverrides as any).methodResponses = Object.keys(method.responses).map(statusCode => {
      return {
        statusCode,
        responseModels: {
          'application/json': new apigateway.CfnModel(responses, statusCode, {
            restApiId: this.restApiId,
            contentType: 'application/json',
            schema: (method.responses as {[key: string]: Type<any>})[statusCode].toJsonSchema()
          }).modelName
        },
        // TODO: responseParameters
      };
    });
  }

  private makeHandler(httpMethod: string, method: Method<any, any, any, any>): void {
    method.integration.mapResource(this);
    const responseMappers: ResponseMappers = {} as ResponseMappers;
    Object.keys(method.responses).forEach(statusCode => {
      // TODO: can we return raw here?
      (responseMappers as any)[statusCode] = Raw.forType(method.responses[statusCode]);
    });
    this.methods[httpMethod.toUpperCase()] = {
      handler: method.handle,
      requestMapper: Raw.forShape(method.request.shape),
      responseMappers
    };
  }
}

function velocityTemplate<S extends Shape>(
    shape: Shape,
    mappings?: RequestMappings<S, any>,
    root: string = "$input.path('$')"): string {

  let template = `#set($inputRoot = ${root})\n`;
  template += '{\n';

  function walk(shape: Shape, name: string, mapping: TypedMapping<any, any> | object, depth: number) {
    template += '  '.repeat(depth);
    if (mapping) {
      if ((mapping as any)[isMapping]) {
        template += `"${name}": ${(mapping as Mapping).path}`;
      } else if (typeof mapping === 'object') {
        template += `"${name}": {\n`;
        Object.keys(mapping).forEach((childName, i) => {
          const childShape = (shape[childName] as StructType<any>).shape;
          walk(childShape, childName, (mapping as any)[childName], depth + 1);
          if (i + 1 < Object.keys(mapping).length) {
            template += ',\n';
          } else {
            template += `\n${'  '.repeat(depth)}}`;
          }
        });
      } else {
        throw new Error(`unexpected type when generating velocity template: ${typeof mapping}`);
      }
    } else {
      const type = shape[name];
      let path: string;
      if (type.kind === Kind.String || type.kind === Kind.Timestamp || type.kind === Kind.Binary) {
        path = `"$inputRoot.${name}"`;
      } else {
        path = `$inputRoot.${name}`;
      }
      // TODO: understand type, quote strings etc.
      template += `"${name}":${path}`;
    }
  }

  let i = 0;
  const keys = new Set(Object.keys(shape).concat(Object.keys(mappings || {})));
  for (const childName of keys) {
    walk(shape, childName, (mappings as any)[childName], 1);
    if (i + 1 < keys.size) {
      template += ',';
    }
    template += '\n';
    i += 1;
  }
  template += '}\n';
  return template;
}
