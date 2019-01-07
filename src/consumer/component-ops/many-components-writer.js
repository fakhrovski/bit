// @flow
import path from 'path';
import R from 'ramda';
import fs from 'fs-extra';
import { moveExistingComponent } from './move-components';
import { linkComponents } from '../../links';
import { installNpmPackagesForComponents } from '../../npm-client/install-packages';
import * as packageJson from '../component/package-json';
import type { ComponentWithDependencies } from '../../scope';
import type Component from '../component/consumer-component';
import type { Remotes } from '../../remotes';
import { COMPONENT_ORIGINS } from '../../constants';
import logger from '../../logger/logger';
import { Analytics } from '../../analytics/analytics';
import type Consumer from '../consumer';
import { isDir, isDirEmptySync } from '../../utils';
import GeneralError from '../../error/general-error';
import type ComponentMap from '../bit-map/component-map';
import ComponentWriter from './component-writer';
import type { ComponentWriterProps } from './component-writer';
import { getScopeRemotes } from '../../scope/scope-remotes';
import type { PathOsBasedAbsolute } from '../../utils/path';

type ManyComponentsWriterParams = {
  consumer: Consumer,
  silentPackageManagerResult?: boolean,
  componentsWithDependencies: ComponentWithDependencies[],
  writeToPath?: string,
  override?: boolean,
  writePackageJson?: boolean,
  writeConfig?: boolean,
  configDir?: string,
  writeBitDependencies?: boolean,
  createNpmLinkFiles?: boolean,
  writeDists?: boolean,
  saveDependenciesAsComponents?: boolean, // as opposed to npm packages
  installNpmPackages?: boolean,
  installPeerDependencies?: boolean,
  addToRootPackageJson?: boolean,
  verbose?: boolean,
  excludeRegistryPrefix?: boolean
};
type Files = {
  [filePath: string]: string
};

/**
 * write the components into '/components' dir (or according to the bit.map) and its dependencies in the
 * '/components/.dependencies' dir. Both directories are configurable in bit.json
 * For example: global/a has a dependency my-scope/global/b@1. The directories will be:
 * project/root/components/global/a/impl.js
 * project/root/components/.dependencies/global/b/my-scope/1/impl.js
 *
 * In case there are some same dependencies shared between the components, it makes sure to
 * write them only once.
 */
export default class ManyComponentsWriter {
  consumer: Consumer;
  silentPackageManagerResult: ?boolean;
  componentsWithDependencies: ComponentWithDependencies[];
  writeToPath: ?string;
  override: boolean;
  writePackageJson: boolean;
  writeConfig: boolean;
  configDir: ?string;
  writeBitDependencies: boolean;
  createNpmLinkFiles: boolean;
  writeDists: boolean;
  saveDependenciesAsComponents: boolean; // as opposed to npm packages
  installNpmPackages: boolean;
  installPeerDependencies: boolean;
  addToRootPackageJson: boolean;
  verbose: boolean;
  excludeRegistryPrefix: boolean;
  dependenciesIdsCache: Object;
  writtenComponents: Component[];
  writtenDependencies: Component[];
  isolated: Boolean; // a preparation for the capsule feature
  constructor(params: ManyComponentsWriterParams) {
    this.consumer = params.consumer;
    this.silentPackageManagerResult = params.silentPackageManagerResult;
    this.componentsWithDependencies = params.componentsWithDependencies;
    this.writeToPath = params.writeToPath;
    this.override = this._setBooleanDefault(params.override, true);
    this.writePackageJson = this._setBooleanDefault(params.writePackageJson, true);
    this.writeConfig = this._setBooleanDefault(params.writeConfig, false);
    this.configDir = params.configDir;
    this.writeBitDependencies = this._setBooleanDefault(params.writeBitDependencies, false);
    this.createNpmLinkFiles = this._setBooleanDefault(params.createNpmLinkFiles, false);
    this.writeDists = this._setBooleanDefault(params.writeDists, true);
    this.saveDependenciesAsComponents = this._setBooleanDefault(params.saveDependenciesAsComponents, false);
    this.installNpmPackages = this._setBooleanDefault(params.installNpmPackages, true);
    this.addToRootPackageJson = this._setBooleanDefault(params.addToRootPackageJson, true);
    this.verbose = this._setBooleanDefault(params.verbose, false);
    this.excludeRegistryPrefix = this._setBooleanDefault(params.excludeRegistryPrefix, false);
    this.dependenciesIdsCache = {};
  }
  _setBooleanDefault(field: ?boolean, defaultValue: boolean): boolean {
    return typeof field === 'undefined' ? defaultValue : Boolean(field);
  }
  async writeAll() {
    await this._determineWhetherDependenciesAreSavedAsComponents();
    await this.writeComponents();
    await this.writeDependencies();
    this.moveComponentsIfNeeded();
    // add workspaces if flag is true
    await packageJson.addWorkspacesToPackageJson(this.consumer, this.writeToPath);
    await this.installPackagesIfNeeded();
    if (this.addToRootPackageJson) {
      await packageJson.addComponentsToRoot(this.consumer, this.writtenComponents.map(c => c.id));
    }
    await this.linkAll();
  }
  async getAllData() {
    await this._determineWhetherDependenciesAreSavedAsComponents();
    await this.populateComponentsFilesToWrite();
    await this.populateComponentsDependenciesToWrite();
    this.moveComponentsIfNeeded();
    await this._persistData();
    // from here the data is written directly
    await packageJson.addWorkspacesToPackageJson(this.consumer, this.writeToPath);
    await this.installPackagesIfNeeded();
    if (this.addToRootPackageJson) {
      await packageJson.addComponentsToRoot(this.consumer, this.writtenComponents.map(c => c.id));
    }
    await this.linkAll();
  }
  async _persistData() {
    const writeAll = this.componentsWithDependencies.map((componentWithDeps) => {
      const allComponents = [componentWithDeps.component, ...componentWithDeps.allDependencies];
      const filesToWriteP = allComponents.map(component => component.dataToPersist.files.map(f => f.write()));
      return Promise.all(R.flatten(filesToWriteP));
    });
    return Promise.all(writeAll);
  }
  async writeComponents() {
    const writeComponentsParams = this._getWriteComponentsParams();
    const writeComponentsP = writeComponentsParams.map((writeParams) => {
      const componentWriter = ComponentWriter.getInstance(writeParams);
      return componentWriter.write();
    });
    this.writtenComponents = await Promise.all(writeComponentsP);
  }
  async populateComponentsFilesToWrite() {
    const writeComponentsParams = this._getWriteComponentsParams();
    const writeComponentsP = writeComponentsParams.map((writeParams) => {
      const componentWriter = ComponentWriter.getInstance(writeParams);
      return componentWriter.getComponentsFilesToWrite();
    });
    await Promise.all(writeComponentsP);
  }
  async _determineWhetherDependenciesAreSavedAsComponents() {
    const remotes: Remotes = await getScopeRemotes(this.consumer.scope);
    this.componentsWithDependencies.forEach((componentWithDeps: ComponentWithDependencies) => {
      // if it doesn't go to the hub, it can't import dependencies as packages
      componentWithDeps.component.dependenciesSavedAsComponents =
        this.saveDependenciesAsComponents || !remotes.isHub(componentWithDeps.component.scope);
    });
  }
  _getWriteComponentsParams(): ComponentWriterProps[] {
    return this.componentsWithDependencies.map((componentWithDeps: ComponentWithDependencies) =>
      this._getWriteParamsOfOneComponent(componentWithDeps)
    );
  }
  _getWriteParamsOfOneComponent(componentWithDeps: ComponentWithDependencies): ComponentWriterProps {
    const componentRootDir: PathOsBasedAbsolute = this.writeToPath
      ? path.resolve(this.writeToPath)
      : this.consumer.composeComponentPath(componentWithDeps.component.id);
    const getParams = () => {
      if (this.isolated) {
        return {
          origin: COMPONENT_ORIGINS.AUTHORED
        };
      }
      // AUTHORED and IMPORTED components can't be saved with multiple versions, so we can ignore the version to
      // find the component in bit.map
      const componentMap = this.consumer.bitMap.getComponentPreferNonNested(componentWithDeps.component.id);
      const origin =
        componentMap && componentMap.origin === COMPONENT_ORIGINS.AUTHORED
          ? COMPONENT_ORIGINS.AUTHORED
          : COMPONENT_ORIGINS.IMPORTED;
      const configDirFromComponentMap = componentMap ? componentMap.configDir : undefined;
      this.throwErrorWhenDirectoryNotEmpty(componentRootDir, componentMap);
      // don't write dists files for authored components as the author has its own mechanism to generate them
      // also, don't write dists file for imported component, unless the user used '--dist' flag
      componentWithDeps.component.dists.writeDistsFiles = this.writeDists && origin === COMPONENT_ORIGINS.IMPORTED;
      return {
        configDir: this.configDir || configDirFromComponentMap,
        origin,
        existingComponentMap: componentMap
      };
    };
    return {
      ...this._getDefaultWriteParams(),
      component: componentWithDeps.component,
      writeToPath: componentRootDir,
      writeBitDependencies: this.writeBitDependencies || !componentWithDeps.component.dependenciesSavedAsComponents, // when dependencies are written as npm packages, they must be written in package.json
      ...getParams()
    };
  }

  _getDefaultWriteParams(): Object {
    return {
      override: true,
      writeConfig: this.writeConfig,
      writePackageJson: this.writePackageJson,
      consumer: this.consumer,
      excludeRegistryPrefix: this.excludeRegistryPrefix
    };
  }
  async writeDependencies() {
    const allDependenciesP = this.componentsWithDependencies.map((componentWithDeps: ComponentWithDependencies) => {
      const writeDependenciesP = componentWithDeps.allDependencies.map((dep: Component) => {
        const dependencyId = dep.id.toString();
        const depFromBitMap = this.consumer.bitMap.getComponentIfExist(dep.id);
        if (!componentWithDeps.component.dependenciesSavedAsComponents && !depFromBitMap) {
          // when depFromBitMap is true, it means that this component was imported as a component already before
          // don't change it now from a component to a package. (a user can do it at any time by using export --eject).
          logger.debug(
            `writeToComponentsDir, ignore dependency ${dependencyId}. It'll be installed later using npm-client`
          );
          Analytics.addBreadCrumb(
            'writeToComponentsDir',
            `writeToComponentsDir, ignore dependency ${Analytics.hashData(
              dependencyId
            )}. It'll be installed later using npm-client`
          );
          return Promise.resolve(null);
        }
        if (depFromBitMap && depFromBitMap.origin === COMPONENT_ORIGINS.AUTHORED) {
          dep.writtenPath = this.consumer.getPath();
          logger.debug(`writeToComponentsDir, ignore dependency ${dependencyId} as it already exists in bit map`);
          Analytics.addBreadCrumb(
            'writeToComponentsDir',
            `writeToComponentsDir, ignore dependency ${Analytics.hashData(
              dependencyId
            )} as it already exists in bit map`
          );
          this.consumer.bitMap.addDependencyToParent(componentWithDeps.component.id, dependencyId);
          return Promise.resolve(dep);
        }
        if (depFromBitMap && fs.existsSync(depFromBitMap.rootDir)) {
          dep.writtenPath = depFromBitMap.rootDir;
          logger.debug(
            `writeToComponentsDir, ignore dependency ${dependencyId} as it already exists in bit map and file system`
          );
          Analytics.addBreadCrumb(
            'writeToComponentsDir',
            `writeToComponentsDir, ignore dependency ${Analytics.hashData(
              dependencyId
            )} as it already exists in bit map and file system`
          );
          this.consumer.bitMap.addDependencyToParent(componentWithDeps.component.id, dependencyId);
          return Promise.resolve(dep);
        }
        if (this.dependenciesIdsCache[dependencyId]) {
          logger.debug(`writeToComponentsDir, ignore dependency ${dependencyId} as it already exists in cache`);
          Analytics.addBreadCrumb(
            'writeToComponentsDir',
            `writeToComponentsDir, ignore dependency ${Analytics.hashData(dependencyId)} as it already exists in cache`
          );
          dep.writtenPath = this.dependenciesIdsCache[dependencyId];
          this.consumer.bitMap.addDependencyToParent(componentWithDeps.component.id, dependencyId);
          return Promise.resolve(dep);
        }
        const depRootPath = this.consumer.composeDependencyPath(dep.id);
        dep.writtenPath = depRootPath;
        this.dependenciesIdsCache[dependencyId] = depRootPath;
        // When a component is NESTED we do interested in the exact version, because multiple components with the same scope
        // and namespace can co-exist with different versions.
        const componentMap = this.consumer.bitMap.getComponentIfExist(dep.id);
        const componentWriter = ComponentWriter.getInstance({
          ...this._getDefaultWriteParams(),
          writeConfig: false,
          component: dep,
          writeToPath: depRootPath,
          origin: COMPONENT_ORIGINS.NESTED,
          parent: componentWithDeps.component.id,
          existingComponentMap: componentMap
        });
        return componentWriter.write();
      });

      return Promise.all(writeDependenciesP).then(deps => deps.filter(dep => dep));
    });
    const writtenDependenciesIncludesNull = await Promise.all(allDependenciesP);
    this.writtenDependencies = writtenDependenciesIncludesNull.filter(dep => dep);
  }
  async populateComponentsDependenciesToWrite() {
    const allDependenciesP = this.componentsWithDependencies.map((componentWithDeps: ComponentWithDependencies) => {
      const writeDependenciesP = componentWithDeps.allDependencies.map((dep: Component) => {
        const dependencyId = dep.id.toString();
        const depFromBitMap = this.consumer.bitMap.getComponentIfExist(dep.id);
        if (!componentWithDeps.component.dependenciesSavedAsComponents && !depFromBitMap) {
          // when depFromBitMap is true, it means that this component was imported as a component already before
          // don't change it now from a component to a package. (a user can do it at any time by using export --eject).
          logger.debug(
            `writeToComponentsDir, ignore dependency ${dependencyId}. It'll be installed later using npm-client`
          );
          Analytics.addBreadCrumb(
            'writeToComponentsDir',
            `writeToComponentsDir, ignore dependency ${Analytics.hashData(
              dependencyId
            )}. It'll be installed later using npm-client`
          );
          return Promise.resolve(null);
        }
        if (depFromBitMap && depFromBitMap.origin === COMPONENT_ORIGINS.AUTHORED) {
          dep.writtenPath = this.consumer.getPath();
          logger.debug(`writeToComponentsDir, ignore dependency ${dependencyId} as it already exists in bit map`);
          Analytics.addBreadCrumb(
            'writeToComponentsDir',
            `writeToComponentsDir, ignore dependency ${Analytics.hashData(
              dependencyId
            )} as it already exists in bit map`
          );
          this.consumer.bitMap.addDependencyToParent(componentWithDeps.component.id, dependencyId);
          return Promise.resolve(dep);
        }
        if (depFromBitMap && fs.existsSync(depFromBitMap.rootDir)) {
          dep.writtenPath = depFromBitMap.rootDir;
          logger.debug(
            `writeToComponentsDir, ignore dependency ${dependencyId} as it already exists in bit map and file system`
          );
          Analytics.addBreadCrumb(
            'writeToComponentsDir',
            `writeToComponentsDir, ignore dependency ${Analytics.hashData(
              dependencyId
            )} as it already exists in bit map and file system`
          );
          this.consumer.bitMap.addDependencyToParent(componentWithDeps.component.id, dependencyId);
          return Promise.resolve(dep);
        }
        if (this.dependenciesIdsCache[dependencyId]) {
          logger.debug(`writeToComponentsDir, ignore dependency ${dependencyId} as it already exists in cache`);
          Analytics.addBreadCrumb(
            'writeToComponentsDir',
            `writeToComponentsDir, ignore dependency ${Analytics.hashData(dependencyId)} as it already exists in cache`
          );
          dep.writtenPath = this.dependenciesIdsCache[dependencyId];
          this.consumer.bitMap.addDependencyToParent(componentWithDeps.component.id, dependencyId);
          return Promise.resolve(dep);
        }
        const depRootPath = this.consumer.composeDependencyPath(dep.id);
        dep.writtenPath = depRootPath;
        this.dependenciesIdsCache[dependencyId] = depRootPath;
        // When a component is NESTED we do interested in the exact version, because multiple components with the same scope
        // and namespace can co-exist with different versions.
        const componentMap = this.consumer.bitMap.getComponentIfExist(dep.id);
        const componentWriter = ComponentWriter.getInstance({
          ...this._getDefaultWriteParams(),
          writeConfig: false,
          component: dep,
          writeToPath: depRootPath,
          origin: COMPONENT_ORIGINS.NESTED,
          parent: componentWithDeps.component.id,
          existingComponentMap: componentMap
        });
        return componentWriter.getComponentsFilesToWrite();
      });

      return Promise.all(writeDependenciesP).then(deps => deps.filter(dep => dep));
    });
    const writtenDependenciesIncludesNull = await Promise.all(allDependenciesP);
    this.writtenDependencies = writtenDependenciesIncludesNull.filter(dep => dep);
  }

  moveComponentsIfNeeded() {
    if (this.writeToPath) {
      this.componentsWithDependencies.forEach((componentWithDeps) => {
        const relativeWrittenPath = this.consumer.getPathRelativeToConsumer(componentWithDeps.component.writtenPath);
        const absoluteWrittenPath = this.consumer.toAbsolutePath(relativeWrittenPath);
        // $FlowFixMe this.writeToPath is set
        const absoluteWriteToPath = path.resolve(this.writeToPath); // don't use consumer.toAbsolutePath, it might be an inner dir
        if (relativeWrittenPath && absoluteWrittenPath !== absoluteWriteToPath) {
          const component = componentWithDeps.component;
          moveExistingComponent(this.consumer, component, absoluteWrittenPath, absoluteWriteToPath);
        }
      });
    }
  }
  async installPackagesIfNeeded() {
    if (this.installNpmPackages) {
      await installNpmPackagesForComponents({
        consumer: this.consumer,
        componentsWithDependencies: this.componentsWithDependencies,
        verbose: this.verbose,
        silentPackageManagerResult: this.silentPackageManagerResult,
        installPeerDependencies: this.installPeerDependencies
      });
    }
  }
  async linkAll() {
    return linkComponents({
      componentsWithDependencies: this.componentsWithDependencies,
      writtenComponents: this.writtenComponents,
      writtenDependencies: this.writtenDependencies,
      consumer: this.consumer,
      createNpmLinkFiles: this.createNpmLinkFiles,
      writePackageJson: this.writePackageJson
    });
  }

  throwErrorWhenDirectoryNotEmpty(componentDir: string, componentMap: ?ComponentMap) {
    // if not writeToPath specified, it goes to the default directory. When componentMap exists, the
    // component is not new, and it's ok to override the existing directory.
    if (!this.writeToPath && componentMap) return;
    // if writeToPath specified and that directory is already used for that component, it's ok to override
    if (this.writeToPath && componentMap && componentMap.rootDir && componentMap.rootDir === this.writeToPath) return;

    if (fs.pathExistsSync(componentDir)) {
      if (!isDir(componentDir)) {
        throw new GeneralError(`unable to import to ${componentDir} because it's a file`);
      }
      if (!isDirEmptySync(componentDir) && !this.override) {
        throw new GeneralError(
          `unable to import to ${componentDir}, the directory is not empty. use --override flag to delete the directory and then import`
        );
      }
    }
  }
}
