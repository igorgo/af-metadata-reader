#!/usr/bin/env node --harmony
/**
 * Created by igorgo on 02.07.2017.
 */
const
    inquirer = require('inquirer'),
    oracledb = require('oracledb'),
    program = require('commander'),
    Extractor = require('./extractor'),
    utils = require('./utils')

let R = require('./res/strings/index-en')

let oci, language

oracledb.maxRows = 10000
oracledb.outFormat = oracledb.OBJECT // {outFormat : oracledb.ARRAY}
oracledb.fetchAsString = [oracledb.CLOB]

const main = async () => {
    utils.con('')
    language = (await inquirer.prompt({
        type: 'list',
        name: 'language',
        message: 'Choose a language',
        choices: [
            {name: 'English', value: 'en'},
            {name: 'Ukrainian', value: 'uk'},
            {name: 'Russian', value: 'ru'}
        ]
    })).language
    exports.language = language
    if (language !== 'en') R = require('./res/strings/index-' + language)
    let params = await askParams()
    oci = await connectDB(params.username, params.password, params.dbname)
    exports.oci = oci
    await exportClass(params.singleClass, params.directory)
    return await closeConnection()
}


const exportClass = async (classCode, dir) => {
    const extractor = new Extractor()
    await extractor.extractClass(classCode, dir)

}

const askParams = async () => {
    let params = {}
    program
        .arguments('<class>')
        .option('-b, --dbname <dbname>', R.dbAliasPrompt)
        .option('-u, --username <username>', R.dbUserPrompt)
        .option('-p, --password <password>', R.dbPassPrompt)
        .option('-d, --directory <directory>', R.rootDirPrompt)
        .parse(process.argv)
    params.dbname = program.dbname ||
        (await inquirer.prompt({
            type: 'input',
            message: R.dbAliasPrompt + ':',
            name: 'dbname'
        })).dbname
    params.username = program.username ||
        (await inquirer.prompt({
            type: 'input',
            message: R.dbUserPrompt + ':',
            name: 'username'
        })).username
    params.password = program.password ||
        (await inquirer.prompt({
            type: 'password',
            message: R.dbPassPrompt + ':',
            name: 'password'
        })).password
    params.directory = program.directory ||
        (await inquirer.prompt({
            type: 'input',
            message: R.rootDirPrompt + ':',
            name: 'directory'
        })).directory
    if (program.args.length === 0) {
        // todo: ask for several classes
        // program.help()
        params.extractOneMore = (await inquirer.prompt({
            type: 'list',
            name: 'extractOneMore',
            message: R.oneMorePrompt,
            choices: [
                {name: R.oneMoreOne, value: 1},
                {name: R.oneMoreMore, value: 2}
            ]
        })).extractOneMore
        if (params.extractOneMore === 1) {
            params.singleClass = (await inquirer.prompt({
                type: 'input',
                message: R.singleClassPrompt,
                name: 'singleClass'
            })).singleClass
        }
        else {
            params.extractMoreType = (await inquirer.prompt({
                type: 'list',
                name: 'extractMoreType',
                message: R.moreTypePrompt,
                choices: [
                    {name: R.moreTypeAll, value: 'A'},
                    {name: R.moreTypeG, value: 'G'},
                    {name: R.moreTypeL, value: 'L'},
                    {name: R.moreTypeR, value: 'R'}
                ]
            })).extractMoreType
            if (params.extractMoreType === 'G' || params.extractMoreType === 'R') {
                params.startClass = (await inquirer.prompt({
                    type: 'input',
                    message: R.startClassPrompt,
                    name: 'startClass'
                })).startClass
            }
            if (params.extractMoreType === 'L' || params.extractMoreType === 'R') {
                params.finishClass = (await inquirer.prompt({
                    type: 'input',
                    message: R.finishClassPrompt,
                    name: 'finishClass'
                })).finishClass
            }
            params.extractTechType = (await inquirer.prompt({
                type: 'list',
                name: 'extractTechType',
                message: R.techTypePrompt,
                choices: [
                    {name: R.techTypeAll, value: 'A'},
                    {name: R.techTypeS, value: 'S'},
                    {name: R.techTypeU, value: 'U'}
                ]
            })).extractTechType
        }
    } else {
        params.singleClass = program.args[0]
    }
    if (params.singleClass) {
        params.recursive = (await inquirer.prompt({
            type: 'confirm',
            message: R.recursivePrompt,
            name: 'recursive'
        })).recursive
    }
    params.extractOnlyFilled = (await inquirer.prompt({
        type: 'confirm',
        name: 'extractOnlyFilled',
        message: R.onlyFilledPrompt
    })).extractOnlyFilled

    return params
}

const connectDB = async (dbUser, dbPass, dbName) => {
    utils.con(R.connectMessage)
    let connect = await oracledb.getConnection({
        user: dbUser,
        password: dbPass,
        connectString: dbName
    })
    utils.conE(R.connectedMessage)
    return connect
}

const closeConnection = async () => {
    utils.conE(R.closeDbMessage)
    let c = await oci.close()
    utils.conE(R.closedDbMessage)
    utils.conU('')
    return c
}

main()
    .then(() => {
        process.exit(0)
    })
    .catch((e) => {
        utils.conE(e)
        closeConnection()
            .then(() => process.exit(1))
            .catch(() => process.exit(1))
    })

