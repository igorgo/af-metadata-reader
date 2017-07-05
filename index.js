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

let oci
oracledb.maxRows = 10000
oracledb.outFormat = oracledb.OBJECT // {outFormat : oracledb.ARRAY}
oracledb.fetchAsString = [oracledb.CLOB]

const main = async () => {
    let params = await askParams()
    oci = await connectDB(params.username, params.password, params.dbname)
    await exportClass(params.singleClass, params.directory)
    return await closeConnection()
}

const exportClass = async (classCode, dir) => {
    const extractor = new Extractor(oci)
    await extractor.extractClass(classCode, dir)

}

const askParams = async () => {
    let params = {}
    program
        .arguments('<class>')
        .option('-b, --dbname <dbname>', 'The database alias from tnsnames.ora')
        .option('-u, --username <username>', 'The user to authenticate as')
        .option('-p, --password <password>', 'The user\'s password')
        .option('-d, --directory <directory>', 'The directory to save metadata')
        .parse(process.argv)
    params.dbname = program.dbname ||
        (await inquirer.prompt({
            type: 'input',
            message: 'The database alias from tnsnames.ora:',
            name: 'dbname'
        })).dbname
    params.username = program.username ||
        (await inquirer.prompt({
            type: 'input',
            message: 'The user to connect with database:',
            name: 'username'
        })).username
    params.password = program.password ||
        (await inquirer.prompt({
            type: 'password',
            message: 'The user\'s password:',
            name: 'password'
        })).password
    params.directory = program.directory ||
        (await inquirer.prompt({
            type: 'input',
            message: 'The directory to save metadata:',
            name: 'directory'
        })).directory
    if (program.args.length === 0) {
        // todo: ask for several classes
        program.help()
    } else {
        params.singleClass = program.args[0]
    }
    return params
}

const connectDB = async (dbUser, dbPass, dbName) => {
    utils.con('Connecting to the database…')
    let connect = await oracledb.getConnection({
        user: dbUser,
        password: dbPass,
        connectString: dbName
    })
    utils.conE(' connected!')
    return connect
}

const closeConnection = async () => {
    utils.con('Closing db connection... ')
    let c = await oci.close()
    utils.conE('closed.')
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

